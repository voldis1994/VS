//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func openBrowser(url string) {
	_ = exec.Command("cmd", "/c", "start", "", url).Start()
}

func killPort(port string) {
	out, err := exec.Command("netstat", "-ano").Output()
	if err != nil {
		return
	}
	for _, pid := range listeningPIDs(string(out), port) {
		_ = exec.Command("taskkill", "/F", "/PID", pid).Run()
	}
}

func killMatchingNode(root string) {
	// Port kills cover leftover npm/tsx. Extra: stop node that still holds our tools.
	_ = root
}
