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
		// /T = kill process tree (npm → node → tsx)
		_ = exec.Command("taskkill", "/F", "/T", "/PID", pid).Run()
	}
}

// killMatchingNode stops leftover tsx/vite/npm. PALAIST = aizver visu Node.
// Port-only kill misses tsx that is still inside migrate() and not listening on :3000.
func killMatchingNode(root string) {
	_ = root
	_ = exec.Command("taskkill", "/F", "/IM", "node.exe").Run()
	_ = exec.Command("taskkill", "/F", "/IM", "npm.exe").Run()
	_ = exec.Command("taskkill", "/F", "/IM", "tsx.exe").Run()
}
