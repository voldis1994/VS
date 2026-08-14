package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

func main() {
	root, err := findRepoRoot()
	if err != nil {
		writeFatal(err.Error())
		return
	}
	fmt.Println("============================================================")
	fmt.Println("  VS LAUNCHER")
	fmt.Println("  Panelis: http://127.0.0.1:18090")
	fmt.Println("  Mape:   ", root)
	fmt.Println("  NEAIZVER SO LOGU")
	fmt.Println("============================================================")
	app := newApp(root)
	app.log("Mape: %s", root)
	if maybeSelfUpdate(root, app.log) {
		os.Exit(0)
	}
	app.set(func(s *Status) {
		s.GithubSHA, _ = fetchGithubSHA()
		s.LocalSHA = readLocalSHA(root)
		s.Updated = s.LocalSHA != "" && s.LocalSHA == s.GithubSHA
	})
	if err := app.serve(); err != nil {
		writeFatal("nevar atvert paneli :18090 — " + err.Error())
	}
}

func findRepoRoot() (string, error) {
	if len(os.Args) > 1 {
		p := os.Args[1]
		if isRepo(p) {
			return p, nil
		}
	}
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates, dir, filepath.Dir(dir))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, wd)
	}
	for _, c := range candidates {
		cur := c
		for i := 0; i < 8; i++ {
			if isRepo(cur) {
				return cur, nil
			}
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			cur = parent
		}
	}
	return "", fmt.Errorf("VS mape nav atrasta. Liek VS.exe blakus VS.bat (C:\\VS-main)")
}

func isRepo(dir string) bool {
	_, e1 := os.Stat(filepath.Join(dir, "apps", "dashboard", "package.json"))
	_, e2 := os.Stat(filepath.Join(dir, "apps", "control-api", "package.json"))
	return e1 == nil && e2 == nil
}

func writeFatal(msg string) {
	_ = os.WriteFile("vs-launcher-fatal.txt", []byte(msg+"\n"), 0644)
	if runtime.GOOS == "windows" {
		_ = exec.Command("cmd", "/c", "start", "cmd", "/k", "echo "+msg+" && pause").Start()
	}
	time.Sleep(300 * time.Millisecond)
	os.Exit(1)
}
