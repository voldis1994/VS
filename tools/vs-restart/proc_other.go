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
	_ = exec.Command("pkill", "-f", "apps/control-api").Run()
	_ = exec.Command("pkill", "-f", "apps/dashboard").Run()
	_ = exec.Command("pkill", "-f", "client-public.mjs").Run()
}

func listNodePIDs() []string { return nil }

func killPIDTree(pid string) { _ = pid }

func trackChild(pid int) { _ = pid }

func terminateJob() {}
