package process

import (
	"fmt"
	"os/exec"
	"strconv"
	"syscall"
)

func detachedProcess() *syscall.SysProcAttr {
	const detachedProcessFlag = 0x00000008 // DETACHED_PROCESS
	return &syscall.SysProcAttr{CreationFlags: detachedProcessFlag | syscall.CREATE_NEW_PROCESS_GROUP}
}

func processRunning(pid int) bool {
	handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle)
	state, err := syscall.WaitForSingleObject(handle, 0)
	return err == nil && state == syscall.WAIT_TIMEOUT
}

func stopProcess(pid int) error {
	const invalidParameter = syscall.Errno(87) // ERROR_INVALID_PARAMETER
	handle, err := syscall.OpenProcess(syscall.PROCESS_TERMINATE|syscall.SYNCHRONIZE, false, uint32(pid))
	if err == invalidParameter { // process has already exited
		return nil
	}
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	if err := syscall.TerminateProcess(handle, 0); err != nil {
		if state, _ := syscall.WaitForSingleObject(handle, 0); state == syscall.WAIT_OBJECT_0 {
			return nil
		}
		return err
	}
	// TerminateProcess is asynchronous. Wait before restart tries to bind again.
	state, err := syscall.WaitForSingleObject(handle, 5000)
	if err != nil {
		return err
	}
	if state != syscall.WAIT_OBJECT_0 {
		return fmt.Errorf("daemon (pid %d) did not exit after termination", pid)
	}
	return nil
}

func logCommand(path string, lines int, follow bool) *exec.Cmd {
	command := "$ErrorActionPreference = 'Stop'; Get-Content -LiteralPath $env:OPEN_WEBBRIDGE_LOG_PATH -Encoding UTF8 -Tail " + strconv.Itoa(lines)
	if follow {
		command += " -Wait"
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)
	cmd.Env = append(cmd.Environ(), "OPEN_WEBBRIDGE_LOG_PATH="+path)
	return cmd
}
