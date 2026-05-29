// Package wsserver is a tiny, dependency-free RFC 6455 WebSocket server.
//
// We only ever talk to our own browser extension over loopback, so we
// implement exactly the subset we need (text frames, fragmentation,
// ping/pong, close) and nothing else. This keeps the daemon free of any
// third-party module — it builds offline and there is no supply chain to
// audit, which matters for a tool that can drive your logged-in browser.
package wsserver

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// maxMessageSize caps a single assembled message (64 MiB). Screenshots and
// PDFs travel base64-encoded so this needs healthy headroom.
const maxMessageSize = 64 << 20

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// Conn is a single upgraded WebSocket connection. ReadMessage is expected to
// be called from one goroutine; writes are safe from many.
type Conn struct {
	raw     net.Conn
	br      *bufio.Reader
	bw      *bufio.Writer
	writeMu sync.Mutex
	closed  bool
}

// Upgrade performs the server handshake and hijacks the TCP connection.
func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!headerHasToken(r.Header, "Connection", "upgrade") {
		return nil, errors.New("not a websocket upgrade request")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("response writer does not support hijacking")
	}
	raw, brw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + computeAccept(key) + "\r\n\r\n"
	if _, err := brw.WriteString(resp); err != nil {
		raw.Close()
		return nil, err
	}
	if err := brw.Flush(); err != nil {
		raw.Close()
		return nil, err
	}
	return &Conn{raw: raw, br: brw.Reader, bw: brw.Writer}, nil
}

// ReadMessage returns the next complete text/binary message as a string,
// transparently answering pings and reassembling fragmented frames.
func (c *Conn) ReadMessage() (string, error) {
	var payload []byte
	for {
		fin, opcode, data, err := c.readFrame()
		if err != nil {
			return "", err
		}
		switch opcode {
		case opText, opBinary, opContinuation:
			if len(payload)+len(data) > maxMessageSize {
				return "", errors.New("message exceeds size limit")
			}
			payload = append(payload, data...)
			if fin {
				return string(payload), nil
			}
		case opPing:
			if err := c.writeFrame(opPong, data); err != nil {
				return "", err
			}
		case opPong:
			// ignore
		case opClose:
			_ = c.writeFrame(opClose, nil)
			return "", io.EOF
		}
	}
}

// WriteMessage sends a single text frame.
func (c *Conn) WriteMessage(s string) error {
	return c.writeFrame(opText, []byte(s))
}

// Ping sends a ping frame (used as an application-level keepalive).
func (c *Conn) Ping() error { return c.writeFrame(opPing, nil) }

// Close sends a close frame and tears down the TCP connection.
func (c *Conn) Close() error {
	c.writeMu.Lock()
	if c.closed {
		c.writeMu.Unlock()
		return nil
	}
	c.closed = true
	c.writeMu.Unlock()
	_ = c.writeControlClose()
	return c.raw.Close()
}

func (c *Conn) writeControlClose() error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	// 1000 = normal closure.
	frame := []byte{0x80 | opClose, 0x02, 0x03, 0xe8}
	_, err := c.bw.Write(frame)
	if err == nil {
		err = c.bw.Flush()
	}
	return err
}

func (c *Conn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(c.br, hdr[:]); err != nil {
		return
	}
	fin = hdr[0]&0x80 != 0
	opcode = hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > maxMessageSize {
		err = errors.New("frame exceeds size limit")
		return
	}
	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, maskKey[:]); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return
}

func (c *Conn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return errors.New("connection closed")
	}
	hdr := make([]byte, 0, 10)
	hdr = append(hdr, 0x80|opcode) // FIN + opcode; server frames are unmasked
	n := len(payload)
	switch {
	case n < 126:
		hdr = append(hdr, byte(n))
	case n < 1<<16:
		hdr = append(hdr, 126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		hdr = append(hdr, ext[:]...)
	}
	if _, err := c.bw.Write(hdr); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := c.bw.Write(payload); err != nil {
			return err
		}
	}
	return c.bw.Flush()
}

func computeAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h[http.CanonicalHeaderKey(name)] {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}
