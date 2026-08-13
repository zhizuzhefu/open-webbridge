// Package files persists large binary results (screenshots, PDFs) returned by
// the extension to disk, so the AI caller receives a short file path instead
// of hundreds of KB of base64 that would flood its context window.
package files

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
)

var safeName = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// MaybePersist inspects a tool result and, for actions that return base64
// blobs, writes the blob to ~/.open-webbridge/files/ and rewrites the result
// to carry a "path" + "sizeBytes" instead of the raw "data" field.
//
// It returns the (possibly rewritten) result. Unknown actions pass through.
func MaybePersist(action string, data json.RawMessage) json.RawMessage {
	switch action {
	case "screenshot", "save_as_pdf":
	case "annotations":
		// Only the screenshot op carries a blob; every other op returns plain
		// JSON with no "data" field and falls through untouched below.
	default:
		return data
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return data
	}
	raw, ok := m["data"]
	if !ok {
		return data
	}
	var b64 string
	if err := json.Unmarshal(raw, &b64); err != nil || b64 == "" {
		return data
	}
	blob, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return data
	}

	ext := "png"
	if action == "save_as_pdf" {
		ext = "pdf"
	} else if f := stringField(m, "format"); f == "jpeg" || f == "jpg" {
		ext = "jpg"
	}
	name := stringField(m, "file_name")
	if name == "" {
		name = stringField(m, "pageTitle")
	}
	path := outputPath(name, ext)

	if err := os.WriteFile(path, blob, 0o644); err != nil {
		return data // best effort; fall back to returning base64
	}

	// Drop the heavy base64 and report the path instead.
	delete(m, "data")
	m["path"] = mustJSON(path)
	m["sizeBytes"] = mustJSON(len(blob))
	out, err := json.Marshal(m)
	if err != nil {
		return data
	}
	return out
}

func outputPath(name, ext string) string {
	ts := time.Now().Format("20060102_150405")
	base := safeName.ReplaceAllString(strings.TrimSpace(name), "-")
	base = strings.Trim(base, "-")
	if base == "" {
		base = ts
	} else {
		base = fmt.Sprintf("%s_%s", base, ts)
	}
	if len(base) > 80 {
		base = base[:80]
	}
	return filepath.Join(config.FilesDir(), base+"."+ext)
}

func stringField(m map[string]json.RawMessage, key string) string {
	raw, ok := m[key]
	if !ok {
		return ""
	}
	var s string
	_ = json.Unmarshal(raw, &s)
	return s
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
