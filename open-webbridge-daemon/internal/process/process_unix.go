//go:build !windows

package process

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

func detachedProcess() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func processRunning(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	defer proc.Release()
	return proc.Signal(syscall.Signal(0)) == nil
}

func stopProcess(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	defer proc.Release()
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	// Give the server time to shut down before forcing termination.
	for i := 0; i < 20; i++ {
		if proc.Signal(syscall.Signal(0)) != nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = proc.Kill()
	return nil
}

func logCommand(path string, lines int, follow bool) *exec.Cmd {
	args := []string{"-n", strconv.Itoa(lines)}
	if follow {
		args = append(args, "-f")
	}
	return exec.Command("tail", append(args, path)...)
}
