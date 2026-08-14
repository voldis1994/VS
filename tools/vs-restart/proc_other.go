//go:build !windows

package main

import (
	"os/exec"
	"runtime"
)

func hideWindow(cmd *exec.Cmd) {}

func openBrowser(url string) {
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", url).Start()
	default:
		_ = exec.Command("xdg-open", url).Start()
	}
}

func killPort(port string) {
	_ = port
}

func killMatchingNode(root string) {
	_ = root
}
