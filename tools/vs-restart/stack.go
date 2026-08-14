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
	applyDotEnv(a.root)

	a.log("[1/5] Apturu vecos procesus — gaidu līdz node.exe NAV...")
	a.log("LAUNCHER id=%s · soļu kārtība: Postgres → ZIP(ja vajag) → API", LauncherID)
	killStack(a.root, a.log)
	if err := requireNoNode(a.log); err != nil {
		return err
	}

	a.log("[2/5] Postgres + Redis (pirms jebkāda failu rakstīšanas)...")
	if err := a.ensureDocker(); err != nil {
		return err
	}

	a.log("[3/5] GitHub update...")
	gh, err := fetchGithubSHA()
	if err != nil {
		a.log("[WARN] GitHub SHA: %s", err.Error())
	} else {
		a.set(func(s *Status) { s.GithubSHA = gh })
		a.log("GitHub main = %s", gh)
	}
	local := readLocalSHA(a.root)
	if shouldSkipZip(local, gh) {
		a.log("[OK] jau %s — ZIP NERALU (failus nepārrakstu → tsx neuzmodinās)", gh)
		a.set(func(s *Status) {
			s.LocalSHA = local
			s.Updated = true
		})
	} else {
		if err := requireNoNode(a.log); err != nil {
			return err
		}
		a.log("[..] SHA atšķiras (lokāli=%s) — ņemu ZIP...", local)
		if err := updateFromZip(a.root, a.log); err != nil {
			return fmt.Errorf("GitHub ZIP update: %w", err)
		}
		if gh != "" {
			_ = os.WriteFile(filepath.Join(a.root, shaFile), []byte(gh+"\n"), 0644)
		}
		a.set(func(s *Status) {
			s.LocalSHA = readLocalSHA(a.root)
			s.Updated = s.LocalSHA != "" && s.LocalSHA == s.GithubSHA
		})
		a.log("[OK] mape atjaunota")
		a.log("[..] pēc ZIP vēlreiz pārbaudu, ka node.exe NAV...")
		if err := requireNoNode(a.log); err != nil {
			return err
		}
	}

	upsertEnv(a.root, map[string]string{
		"OPERATING_MODE":       "LIVE",
		"LIVE_TRADING_ENABLED": "true",
		"MARKET_CORE_BRIDGE":   "1",
		"BUILD_SHA":            readLocalSHA(a.root),
		"DB_HOST":              ipv4LocalDBHost(a.root),
	})
	applyDotEnv(a.root)

	if !portUp("127.0.0.1:5432") {
		a.log("[..] Postgres pazuda — ceļu vēlreiz...")
		if err := a.ensureDocker(); err != nil {
			return err
		}
	}

	a.log("[..] npm + migrate (tikai ja :5432 klausās)...")
	if err := a.npmSetup(); err != nil {
		return err
	}

	a.log("[4/5] Palaisu API + paneli...")
	freeServicePorts(a.log)
	if err := requireNoNode(a.log); err != nil {
		return err
	}
	if err := a.startServices(); err != nil {
		return err
	}

	a.log("[5/5] Gaidu portus...")
	if !waitPortBool("127.0.0.1:5432", 20, a.log) {
		return fmt.Errorf("Postgres :5432 pazuda pēc starta — atver Docker Desktop")
	}
	if !waitPortBool("127.0.0.1:3000", 40, a.log) {
		return fmt.Errorf("API :3000 neklausās — skaties logu virs šīs rindas")
	}
	waitPort("127.0.0.1:18080", 40, a.log)
	openBrowser("http://127.0.0.1:18080")
	openBrowser("http://localhost:5173/clients")
	return nil
}

func killStack(root string, logfn func(string, ...any)) {
	if logfn == nil {
		logfn = func(string, ...any) {}
	}
	names := []string{"market-core.exe", "execution-service.exe", "cloudflared.exe"}
	for _, n := range names {
		_ = exec.Command("taskkill", "/F", "/IM", n).Run()
	}
	_ = exec.Command("taskkill", "/F", "/FI", "WINDOWTITLE eq MR-*").Run()
	for _, port := range []string{"3000", "5173", "5174", "5175", "18080"} {
		killPort(port)
	}
	logfn("[..] apturu Node/tsx (taskkill /T + Job)...")
	killMatchingNode(root)
}

func killNodeUntilGone(logfn func(string, ...any)) {
	if logfn == nil {
		logfn = func(string, ...any) {}
	}
	for i := 1; i <= 20; i++ {
		killMatchingNode("")
		pids := listNodePIDs()
		if len(pids) == 0 {
			logfn("[OK] node.exe nav palicis")
			return
		}
		logfn("[..] vēl node PID %s — nogalinu koku (%d/20)", strings.Join(pids, ","), i)
		for _, pid := range pids {
			killPIDTree(pid)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func requireNoNode(logfn func(string, ...any)) error {
	killNodeUntilGone(logfn)
	left := listNodePIDs()
	if len(left) == 0 {
		return nil
	}
	return fmt.Errorf("nevaru apturēt node.exe (PID %s). Task Manager → End task visiem node.exe, tad spied PALAIST / RESTARTĒT", strings.Join(left, ", "))
}

// freeServicePorts kills whoever holds API/panel ports and waits until free.
// Fixes EADDRINUSE when orphaned node survived VS.exe restart or tsx watch double-bind.
func freeServicePorts(logfn func(string, ...any)) {
	if logfn == nil {
		logfn = func(string, ...any) {}
	}
	ports := []string{"3000", "5173", "5174", "5175", "18080"}
	for attempt := 1; attempt <= 8; attempt++ {
		busy := false
		for _, p := range ports {
			killPort(p)
		}
		killMatchingNode("")
		time.Sleep(400 * time.Millisecond)
		for _, p := range ports {
			addr := "127.0.0.1:" + p
			if portUp(addr) {
				busy = true
				if attempt == 1 || attempt%2 == 0 {
					logfn("[..] ports %s vēl aizņemts — atbrīvoju (%d/8)", addr, attempt)
				}
			}
		}
		if !busy {
			logfn("[OK] porti 3000/18080/5173 brīvi")
			return
		}
		time.Sleep(600 * time.Millisecond)
	}
	logfn("[WARN] kāds ports vēl aizņemts — mēģinu startēt tik un tā")
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
	a.composeUp(docker, true)
	a.log("[..] gaidu līdz Postgres PATIEŠĀM pieņem savienojumus (Engine OK ≠ :5432)...")
	if !a.waitPostgresReady(docker, 90) {
		a.dumpPostgresLogs(docker)
		return fmt.Errorf("Postgres (:5432) nav. Atver Docker Desktop — Engine running + konteineris market-reader-postgres. Tad spied PALAIST / RESTARTĒT")
	}
	if !waitPortBool("127.0.0.1:6379", 40, a.log) {
		return fmt.Errorf("Redis (:6379) nav. Docker Desktop jābūt ieslēgtam. Tad spied PALAIST / RESTARTĒT")
	}
	a.log("[OK] Postgres + Redis klausās — tikai tagad migrate")
	return nil
}

func (a *App) composeUp(docker string, withWait bool) {
	argsList := [][]string{}
	if withWait {
		argsList = append(argsList, []string{"compose", "up", "-d", "--wait", "--wait-timeout", "120", "postgres", "redis"})
	}
	argsList = append(argsList, []string{"compose", "up", "-d", "postgres", "redis"})
	for i, args := range argsList {
		cmd := exec.Command(docker, args...)
		cmd.Dir = a.root
		hideWindow(cmd)
		out, err := cmd.CombinedOutput()
		txt := strings.TrimSpace(string(out))
		if txt != "" {
			a.log("%s", txt)
		}
		if err == nil {
			return
		}
		if i+1 < len(argsList) {
			a.log("[WARN] compose %s — mēģinu bez --wait", err.Error())
			continue
		}
		a.log("[WARN] compose: %s", err.Error())
	}
}

func (a *App) waitPostgresReady(docker string, tries int) bool {
	user := strings.TrimSpace(os.Getenv("DB_USER"))
	if user == "" {
		user = "market_reader"
	}
	db := strings.TrimSpace(os.Getenv("DB_NAME"))
	if db == "" {
		db = "market_reader"
	}
	portOK := 0
	for i := 0; i < tries; i++ {
		if pgIsReady(docker, user, db) {
			a.log("[OK] pg_isready accepting connections")
			return true
		}
		if portUp("127.0.0.1:5432") {
			portOK++
			if portOK >= 5 {
				a.log("[OK] 127.0.0.1:5432 klausās")
				return true
			}
		} else {
			portOK = 0
		}
		if i%5 == 4 {
			a.log("[..] gaidu Postgres :5432 ... %d/%d", i+1, tries)
		}
		time.Sleep(time.Second)
	}
	return false
}

func pgIsReady(docker, user, db string) bool {
	cmd := exec.Command(docker, "exec", "market-reader-postgres", "pg_isready", "-U", user, "-d", db)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return false
	}
	s := strings.ToLower(string(out))
	return strings.Contains(s, "accepting")
}

func (a *App) dumpPostgresLogs(docker string) {
	cmd := exec.Command(docker, "logs", "--tail", "40", "market-reader-postgres")
	hideWindow(cmd)
	out, _ := cmd.CombinedOutput()
	txt := strings.TrimSpace(string(out))
	if txt != "" {
		a.log("Postgres logi:\n%s", txt)
	}
	ps := exec.Command(docker, "ps", "-a", "--filter", "name=market-reader-postgres")
	hideWindow(ps)
	if o, err := ps.CombinedOutput(); err == nil {
		a.log("docker ps: %s", strings.TrimSpace(string(o)))
	}
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
	a.log("[..] DB migrate (gaida Postgres, ja vēl ceļas)...")
	var migErr error
	for i := 1; i <= 8; i++ {
		migErr = a.run(npm, api, "run", "migrate")
		if migErr == nil {
			break
		}
		a.log("[WARN] migrate %d/8: %s", i, migErr.Error())
		time.Sleep(3 * time.Second)
	}
	if migErr != nil {
		return fmt.Errorf("DB migrate: %w", migErr)
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
	applyDotEnv(a.root)
	env := a.childEnv(map[string]string{
		"LIVE_TRADING_ENABLED": "true",
		"OPERATING_MODE":       "LIVE",
		"MARKET_CORE_BRIDGE":   "1",
		"BUILD_SHA":            sha,
		"CLIENT_PANEL_DIST":    dist,
		"CLIENT_DIST":          dist,
		"CLIENT_PUBLIC_PORT":   "18080",
		"CONTROL_API_URL":      "http://127.0.0.1:3000",
	})

	mc := firstExisting(
		filepath.Join(a.root, "build", "windows-debug", "apps", "market-core", "market-core.exe"),
		filepath.Join(a.root, "build", "windows-release", "apps", "market-core", "market-core.exe"),
	)
	pipeTok := pipelineTokenFromEnv(env)
	capKey := envVal(env, "CAPITAL_API_KEY")
	if mc != "" && pipelineTokenOK(pipeTok) && looksRealSecret(capKey) {
		a.spawn(mc, a.root, env, "--mode", "LIVE", "--bridge")
		a.log("[OK] market-core bridge")
	} else {
		a.log("[WARN] C++ market-core IZLAISTS — LIVE bridge vajag PIPELINE_TOKEN. Darbi iet caur Node robotDesk.")
		if mc == "" {
			a.log("  iemesls: market-core.exe nav uzbuivets")
		} else if !pipelineTokenOK(pipeTok) {
			a.log("  iemesls: PIPELINE_TOKEN / PIPELINE_SERVICE_TOKEN tukss vai CHANGE_ME")
		} else if !looksRealSecret(capKey) {
			a.log("  iemesls: CAPITAL_API_KEY .env tukss — Capital atslēgas ir datubāzē, ne C++ env")
		}
	}
	ex := firstExisting(
		filepath.Join(a.root, "build", "windows-debug", "apps", "execution-service", "execution-service.exe"),
		filepath.Join(a.root, "build", "windows-release", "apps", "execution-service", "execution-service.exe"),
	)
	if ex != "" && pipelineTokenOK(pipeTok) {
		a.spawn(ex, a.root, env, "--mode", "LIVE")
		a.log("[OK] execution-service")
	} else if ex != "" {
		a.log("[WARN] C++ execution-service IZLAISTS — darbi caur Node robotDesk + Capital")
	}

	npm := npmBin()
	// serve = tsx WITHOUT watch — watch double-bind → EADDRINUSE :3000 after ZIP/restart
	a.spawn(npm, filepath.Join(a.root, "apps", "control-api"), env, "run", "serve")
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
	if cmd.Process != nil {
		trackChild(cmd.Process.Pid)
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
	cmd.Env = a.childEnv(nil)
	hideWindow(cmd)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return err
	}
	if cmd.Process != nil {
		trackChild(cmd.Process.Pid)
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
	_ = waitPortBool(addr, tries, logfn)
}

func waitPortBool(addr string, tries int, logfn func(string, ...any)) bool {
	for i := 0; i < tries; i++ {
		if portUp(addr) {
			logfn("[OK] %s", addr)
			return true
		}
		time.Sleep(time.Second)
	}
	logfn("[WARN] %s vel nav", addr)
	return false
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

func loadDotEnv(root string) map[string]string {
	out := map[string]string{}
	b, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		return out
	}
	for _, line := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		v = strings.Trim(v, `"'`)
		if k != "" {
			out[k] = v
		}
	}
	return out
}

func applyDotEnv(root string) {
	for k, v := range loadDotEnv(root) {
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}
}

func (a *App) childEnv(extra map[string]string) []string {
	merged := map[string]string{}
	for _, e := range os.Environ() {
		k, v, ok := strings.Cut(e, "=")
		if ok {
			merged[k] = v
		}
	}
	for k, v := range loadDotEnv(a.root) {
		merged[k] = v
	}
	if host, ok := merged["DB_HOST"]; !ok || host == "" || strings.EqualFold(host, "localhost") {
		merged["DB_HOST"] = "127.0.0.1"
	}
	for k, v := range extra {
		if v != "" {
			merged[k] = v
		}
	}
	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	return out
}

func envVal(env []string, key string) string {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return strings.TrimPrefix(e, prefix)
		}
	}
	return ""
}

func looksRealSecret(v string) bool {
	s := strings.TrimSpace(v)
	if s == "" {
		return false
	}
	u := strings.ToUpper(s)
	return !strings.Contains(u, "CHANGE_ME")
}

func pipelineTokenFromEnv(env []string) string {
	t := strings.TrimSpace(envVal(env, "PIPELINE_TOKEN"))
	if t == "" {
		t = strings.TrimSpace(envVal(env, "PIPELINE_SERVICE_TOKEN"))
	}
	return t
}

// Same rules as apps/market-core LIVE bridge — do not start C++ if it will just error.
func pipelineTokenOK(v string) bool {
	s := strings.TrimSpace(v)
	if s == "" {
		return false
	}
	if s == "CHANGE_ME_PIPELINE_TOKEN" || s == "CHANGE_ME_ADMIN_TOKEN" {
		return false
	}
	return looksRealSecret(s)
}

func shouldSkipZip(local, github string) bool {
	local = strings.TrimSpace(local)
	github = strings.TrimSpace(github)
	return local != "" && github != "" && local == github
}

func ipv4LocalDBHost(root string) string {
	h := strings.TrimSpace(loadDotEnv(root)["DB_HOST"])
	if h == "" || strings.EqualFold(h, "localhost") {
		return "127.0.0.1"
	}
	return h
}
