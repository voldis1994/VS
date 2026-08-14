package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const githubZip = "https://codeload.github.com/voldis1994/VS/zip/refs/heads/main"
const githubSHA = "https://api.github.com/repos/voldis1994/VS/commits/main"
const shaFile = ".vs-build-sha"

func (a *App) fullRestart() error {
	a.log("[1/5] Apturu vecos procesus...")
	killStack(a.root)
	time.Sleep(800 * time.Millisecond)

	a.log("[2/5] GitHub update (ZIP, git nav vajadzigs)...")
	gh, err := fetchGithubSHA()
	if err != nil {
		a.log("[WARN] GitHub SHA: %s", err.Error())
	} else {
		a.set(func(s *Status) { s.GithubSHA = gh })
		a.log("GitHub main = %s", gh)
	}
	if err := updateFromZip(a.root, a.log); err != nil {
		a.log("[WARN] update: %s — turpinu ar esošo mapi", err.Error())
	} else {
		if gh != "" {
			_ = os.WriteFile(filepath.Join(a.root, shaFile), []byte(gh+"\n"), 0644)
		}
		a.set(func(s *Status) {
			s.LocalSHA = readLocalSHA(a.root)
			s.Updated = s.LocalSHA != "" && s.LocalSHA == s.GithubSHA
		})
		a.log("[OK] mape atjaunota")
	}

	a.log("[3/5] Docker + npm...")
	if err := a.ensureDocker(); err != nil {
		return err
	}
	upsertEnv(a.root, map[string]string{
		"OPERATING_MODE":       "LIVE",
		"LIVE_TRADING_ENABLED": "true",
		"MARKET_CORE_BRIDGE":   "1",
		"BUILD_SHA":            readLocalSHA(a.root),
	})
	if err := a.npmSetup(); err != nil {
		return err
	}

	a.log("[4/5] Palaisu API + paneli...")
	if err := a.startServices(); err != nil {
		return err
	}

	a.log("[5/5] Gaidu portus...")
	waitPort("127.0.0.1:3000", 40, a.log)
	waitPort("127.0.0.1:18080", 40, a.log)
	openBrowser("http://127.0.0.1:18080")
	openBrowser("http://localhost:5173/clients")
	return nil
}

func killStack(root string) {
	names := []string{"market-core.exe", "execution-service.exe", "cloudflared.exe"}
	for _, n := range names {
		_ = exec.Command("taskkill", "/F", "/IM", n).Run()
	}
	_ = exec.Command("taskkill", "/F", "/FI", "WINDOWTITLE eq MR-*").Run()
	for _, port := range []string{"3000", "5173", "5174", "5175", "18080"} {
		killPort(port)
	}
	killMatchingNode(root)
}

func (a *App) ensureDocker() error {
	docker := look("docker", `C:\Program Files\Docker\Docker\resources\bin\docker.exe`)
	if docker == "" {
		return fmt.Errorf("docker.exe nav. Instale Docker Desktop")
	}
	if out, err := exec.Command(docker, "info").CombinedOutput(); err != nil {
		desk := `C:\Program Files\Docker\Docker\Docker Desktop.exe`
		if _, e := os.Stat(desk); e == nil {
			a.log("[..] starteju Docker Desktop...")
			_ = exec.Command(desk).Start()
		}
		for i := 0; i < 24; i++ {
			if exec.Command(docker, "info").Run() == nil {
				a.log("[OK] Docker Engine")
				break
			}
			if i == 23 {
				return fmt.Errorf("Docker Engine neatbild: %s", strings.TrimSpace(string(out)))
			}
			a.log("[..] gaidu Docker... %d/24", i+1)
			time.Sleep(5 * time.Second)
		}
	} else {
		a.log("[OK] Docker Engine")
	}
	_ = exec.Command(docker, "start", "market-reader-postgres").Run()
	_ = exec.Command(docker, "start", "market-reader-redis").Run()
	cmd := exec.Command(docker, "compose", "up", "-d", "postgres", "redis")
	cmd.Dir = a.root
	if out, err := cmd.CombinedOutput(); err != nil {
		a.log("[WARN] compose: %s", strings.TrimSpace(string(out)))
	}
	time.Sleep(4 * time.Second)
	return nil
}

func (a *App) npmSetup() error {
	npm := npmBin()
	if npm == "" {
		return fmt.Errorf("Node.js / npm nav PATH")
	}
	api := filepath.Join(a.root, "apps", "control-api")
	dash := filepath.Join(a.root, "apps", "dashboard")
	rc := filepath.Join(a.root, ".npmrc")
	if err := a.run(npm, api, "install", "--registry", "https://registry.npmjs.org/", "--userconfig", rc); err != nil {
		return fmt.Errorf("control-api npm install: %w", err)
	}
	if err := a.run(npm, api, "run", "migrate"); err != nil {
		return fmt.Errorf("DB migrate: %w", err)
	}
	if err := a.run(npm, dash, "install", "--registry", "https://registry.npmjs.org/", "--userconfig", rc); err != nil {
		return fmt.Errorf("dashboard npm install: %w", err)
	}
	npx := npxBin()
	if err := a.run(npx, dash, "--yes", "vite", "build", "--config", "vite.client.config.ts"); err != nil {
		return fmt.Errorf("client panel build: %w", err)
	}
	idx := filepath.Join(dash, "dist-client", "index.html")
	if _, err := os.Stat(idx); err != nil {
		return fmt.Errorf("dist-client/index.html nav — client build neizdevas")
	}
	a.log("[OK] dist-client gatavs")
	return nil
}

func (a *App) startServices() error {
	sha := readLocalSHA(a.root)
	dist := filepath.Join(a.root, "apps", "dashboard", "dist-client")
	env := append(os.Environ(),
		"LIVE_TRADING_ENABLED=true",
		"OPERATING_MODE=LIVE",
		"MARKET_CORE_BRIDGE=1",
		"BUILD_SHA="+sha,
		"CLIENT_PANEL_DIST="+dist,
		"CLIENT_DIST="+dist,
		"CLIENT_PUBLIC_PORT=18080",
	)

	mc := firstExisting(
		filepath.Join(a.root, "build", "windows-debug", "apps", "market-core", "market-core.exe"),
		filepath.Join(a.root, "build", "windows-release", "apps", "market-core", "market-core.exe"),
	)
	if mc != "" {
		a.spawn(mc, a.root, env, "--mode", "LIVE", "--bridge")
		a.log("[OK] market-core")
	} else {
		a.log("[WARN] market-core.exe nav — Node robotDesk tik un ta palaižas")
	}
	ex := firstExisting(
		filepath.Join(a.root, "build", "windows-debug", "apps", "execution-service", "execution-service.exe"),
		filepath.Join(a.root, "build", "windows-release", "apps", "execution-service", "execution-service.exe"),
	)
	if ex != "" {
		a.spawn(ex, a.root, env, "--mode", "LIVE")
	}

	npm := npmBin()
	a.spawn(npm, filepath.Join(a.root, "apps", "control-api"), env, "run", "dev")
	a.spawn("node", a.root, env, filepath.Join(a.root, "tools", "client-public.mjs"))
	a.spawn(npm, filepath.Join(a.root, "apps", "dashboard"), env, "run", "dev")

	if cf, err := exec.LookPath("cloudflared"); err == nil {
		a.spawn(cf, a.root, env, "tunnel", "--url", "http://127.0.0.1:18080")
	} else if npx := npxBin(); npx != "" {
		a.spawn(npx, a.root, env, "--yes", "cloudflared", "tunnel", "--url", "http://127.0.0.1:18080")
	}
	return nil
}

func (a *App) spawn(bin, dir string, env []string, args ...string) *exec.Cmd {
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	cmd.Env = env
	hideWindow(cmd)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		a.log("[KLUDA] %s: %s", bin, err.Error())
		return nil
	}
	go pipeLines(stdout, func(s string) {
		a.log("%s", s)
		if u := tunnelURL(s); u != "" {
			a.set(func(st *Status) { st.Tunnel = u })
			a.log("[OK] tunelis %s", u)
		}
	})
	go pipeLines(stderr, func(s string) {
		a.log("%s", s)
		if u := tunnelURL(s); u != "" {
			a.set(func(st *Status) { st.Tunnel = u })
			a.log("[OK] tunelis %s", u)
		}
	})
	return cmd
}

func (a *App) run(bin, dir string, args ...string) error {
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	hideWindow(cmd)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return err
	}
	go pipeLines(stdout, func(s string) { a.log("%s", s) })
	go pipeLines(stderr, func(s string) { a.log("%s", s) })
	return cmd.Wait()
}

func updateFromZip(root string, logfn func(string, ...any)) error {
	tmp := filepath.Join(os.TempDir(), "vs-src.zip")
	unp := filepath.Join(os.TempDir(), "vs-unpack")
	_ = os.Remove(tmp)
	_ = os.RemoveAll(unp)
	logfn("[..] lejupieladeju ZIP...")
	if err := downloadFile(githubZip, tmp); err != nil {
		return err
	}
	logfn("[..] izpaku (Go zip, ne PowerShell)...")
	if err := unzip(tmp, unp); err != nil {
		return err
	}
	src := findVSRoot(unp)
	if src == "" {
		return fmt.Errorf("ZIP nav VS mape")
	}
	logfn("[..] rakstu failus ( .env paliek )")
	return copyTree(src, root)
}

func unzip(zipPath, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		name := filepath.Clean(f.Name)
		if strings.Contains(name, "..") {
			continue
		}
		out := filepath.Join(dest, name)
		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(out, 0755)
			continue
		}
		_ = os.MkdirAll(filepath.Dir(out), 0755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(w, rc)
		w.Close()
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func copyTree(src, dst string) error {
	skipDir := map[string]bool{".git": true, "node_modules": true}
	skipFile := map[string]bool{".env": true, "VS.exe": true, "VS_RESTART.exe": true}
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return nil
		}
		if rel == "." {
			return nil
		}
		base := filepath.Base(path)
		if info.IsDir() && skipDir[base] {
			return filepath.SkipDir
		}
		if !info.IsDir() && skipFile[base] {
			return nil
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		if base == ".env" {
			if _, e := os.Stat(target); e == nil {
				return nil
			}
		}
		_ = os.MkdirAll(filepath.Dir(target), 0755)
		in, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
		if err != nil {
			return nil
		}
		_, copyErr := io.Copy(out, in)
		out.Close()
		return copyErr
	})
}

func findVSRoot(unp string) string {
	var found string
	_ = filepath.Walk(unp, func(path string, info os.FileInfo, err error) error {
		if err != nil || !info.IsDir() {
			return nil
		}
		if _, e := os.Stat(filepath.Join(path, "apps", "dashboard", "package.json")); e == nil {
			if _, e2 := os.Stat(filepath.Join(path, "apps", "control-api", "package.json")); e2 == nil {
				found = path
				return io.EOF
			}
		}
		return nil
	})
	return found
}

func downloadFile(url, dest string) error {
	c := &http.Client{Timeout: 3 * time.Minute}
	res, err := c.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, res.Body)
	return err
}

func fetchGithubSHA() (string, error) {
	c := &http.Client{Timeout: 20 * time.Second}
	req, _ := http.NewRequest("GET", githubSHA, nil)
	req.Header.Set("User-Agent", "VS-launcher")
	res, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct {
		SHA string `json:"sha"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", err
	}
	if len(body.SHA) < 7 {
		return "", fmt.Errorf("tukss sha")
	}
	return body.SHA[:7], nil
}

func readLocalSHA(root string) string {
	b, err := os.ReadFile(filepath.Join(root, shaFile))
	if err == nil {
		s := strings.TrimSpace(string(b))
		if s != "" {
			return s
		}
	}
	cmd := exec.Command("git", "-C", root, "rev-parse", "--short", "HEAD")
	out, err := cmd.Output()
	if err == nil {
		return strings.TrimSpace(string(out))
	}
	return ""
}

func upsertEnv(root string, kv map[string]string) {
	p := filepath.Join(root, ".env")
	if _, err := os.Stat(p); err != nil {
		ex := filepath.Join(root, ".env.example")
		if b, e := os.ReadFile(ex); e == nil {
			_ = os.WriteFile(p, b, 0644)
		}
	}
	raw, _ := os.ReadFile(p)
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	have := map[string]bool{}
	for i, line := range lines {
		for k, v := range kv {
			if strings.HasPrefix(line, k+"=") {
				lines[i] = k + "=" + v
				have[k] = true
			}
		}
	}
	for k, v := range kv {
		if !have[k] {
			lines = append(lines, k+"="+v)
		}
	}
	_ = os.WriteFile(p, []byte(strings.Join(lines, "\n")), 0644)
}

func waitPort(addr string, tries int, logfn func(string, ...any)) {
	for i := 0; i < tries; i++ {
		if portUp(addr) {
			logfn("[OK] %s", addr)
			return
		}
		time.Sleep(time.Second)
	}
	logfn("[WARN] %s vel nav", addr)
}

func tunnelURL(s string) string {
	i := strings.Index(s, "https://")
	if i < 0 {
		return ""
	}
	rest := s[i:]
	if j := strings.Index(rest, "trycloudflare.com"); j >= 0 {
		end := j + len("trycloudflare.com")
		return strings.TrimRight(rest[:end], " \t\r\n")
	}
	return ""
}

func npmBin() string {
	if runtime.GOOS == "windows" {
		if p, err := exec.LookPath("npm.cmd"); err == nil {
			return p
		}
	}
	p, _ := exec.LookPath("npm")
	return p
}

func npxBin() string {
	if runtime.GOOS == "windows" {
		if p, err := exec.LookPath("npx.cmd"); err == nil {
			return p
		}
	}
	p, _ := exec.LookPath("npx")
	return p
}

func look(name, fallback string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	if _, err := os.Stat(fallback); err == nil {
		return fallback
	}
	return ""
}

func firstExisting(paths ...string) string {
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}
