// VS_RESTART — one-click Windows launcher for the VS / Market Reader stack.
// Cross-compile: GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o VS_RESTART.exe .
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	fmt.Println("============================================================")
	fmt.Println("  VS SYSTEM — FULL RESTART LAUNCHER")
	fmt.Println("============================================================")

	root, err := findRepoRoot()
	if err != nil {
		fail(err.Error())
		return
	}
	fmt.Println("  Repo:", root)

	bat := filepath.Join(root, "scripts", "vs_restart_full.bat")
	if _, err := os.Stat(bat); err != nil {
		fail("scripts\\vs_restart_full.bat not found in " + root)
		return
	}

	cmd := exec.Command("cmd.exe", "/c", bat)
	cmd.Dir = root
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	// Detached console inherits so user sees the bat UI
	if err := cmd.Run(); err != nil {
		fail(fmt.Sprintf("restart script failed: %v", err))
		return
	}
}

func findRepoRoot() (string, error) {
	candidates := []string{}

	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates, dir, filepath.Dir(dir))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, wd)
	}

	for _, c := range candidates {
		if isRepo(c) {
			return c, nil
		}
		// walk up a few levels
		cur := c
		for i := 0; i < 6; i++ {
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			if isRepo(parent) {
				return parent, nil
			}
			cur = parent
		}
	}
	return "", fmt.Errorf("could not find VS repo (need apps\\market-core). Put VS_RESTART.exe inside the cloned github.com/voldis1994/VS folder")
}

func isRepo(dir string) bool {
	markers := []string{
		filepath.Join(dir, "apps", "market-core", "CMakeLists.txt"),
		filepath.Join(dir, "apps", "dashboard", "package.json"),
		filepath.Join(dir, "scripts", "vs_restart_full.bat"),
	}
	for _, m := range markers {
		if _, err := os.Stat(m); err != nil {
			return false
		}
	}
	return true
}

func fail(msg string) {
	fmt.Println()
	fmt.Println("[FAIL]", msg)
	fmt.Println()
	fmt.Println("Press Enter to close...")
	_, _ = fmt.Scanln()
	// keep window open briefly if double-clicked without console wait
	time.Sleep(200 * time.Millisecond)
	os.Exit(1)
}

// silence unused on non-windows builds in editors
var _ = strings.TrimSpace
