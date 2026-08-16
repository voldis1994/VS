package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed ui.html
var uiFS embed.FS

const appPort = "18090"

type Status struct {
	Busy       bool   `json:"busy"`
	Running    bool   `json:"running"`
	Phase      string `json:"phase"`
	LocalSHA   string `json:"local_sha"`
	GithubSHA  string `json:"github_sha"`
	Updated    bool   `json:"updated"`
	Error      string `json:"error"`
	Tunnel     string `json:"tunnel"`
	EntryBrain string `json:"entry_brain"`
	SL         string `json:"sl"`
	Launcher   string `json:"launcher"`
	Postgres   bool   `json:"postgres"`
	Redis      bool   `json:"redis"`
	API        bool   `json:"api"`
	Panel      bool   `json:"panel"`
}

type App struct {
	root string
	mu   sync.Mutex
	st   Status
	subs map[chan string]struct{}
	logF *os.File
}

func newApp(root string) *App {
	a := &App{
		root: root,
		subs: map[chan string]struct{}{},
		st: Status{
			Phase:      "GAIDA",
			EntryBrain: "node-robot-desk",
			SL:         "0.20%-of-price",
			LocalSHA:   readLocalSHA(root),
			Launcher:   LauncherID,
		},
	}
	lf, err := os.OpenFile(root+"/vs-launcher.log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		a.logF = lf
	}
	return a
}

func (a *App) log(format string, args ...any) {
	line := time.Now().Format("15:04:05") + "  " + fmt.Sprintf(format, args...)
	if a.logF != nil {
		_, _ = io.WriteString(a.logF, line+"\n")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for ch := range a.subs {
		select {
		case ch <- line:
		default:
		}
	}
}

func (a *App) set(fn func(*Status)) {
	a.mu.Lock()
	fn(&a.st)
	a.mu.Unlock()
}

func (a *App) snapshot() Status {
	a.mu.Lock()
	st := a.st
	a.mu.Unlock()
	st.Postgres = portUp("127.0.0.1:5432")
	st.Redis = portUp("127.0.0.1:6379")
	st.API = portUp("127.0.0.1:3000")
	st.Panel = portUp("127.0.0.1:18080")
	if st.Launcher == "" {
		st.Launcher = LauncherID
	}
	st.Running = !st.Busy && st.Phase == "DARBOJAS" && st.API && st.Postgres
	return st
}

func (a *App) serve() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		b, err := uiFS.ReadFile("ui.html")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(b)
	})
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		st := a.snapshot()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(st)
	})
	mux.HandleFunc("/api/build", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(buildStamp())
	})
	mux.HandleFunc("/api/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST", 405)
			return
		}
		go a.runCycle()
		w.WriteHeader(202)
	})
	// P5: proxy trading desk / health to control-api (engine stays in Node)
	mux.HandleFunc("/api/desk/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/desk")
		switch {
		case path == "" || path == "/":
			path = "/api/robot-desk"
		case path == "/health":
			path = "/api/system/health"
		case path == "/start":
			path = "/api/robot-desk/start"
		case strings.HasPrefix(path, "/stop/"):
			id := strings.TrimPrefix(path, "/stop/")
			path = "/api/robot-desk/" + id + "/stop"
		default:
			path = "/api/robot-desk" + path
		}
		url := "http://127.0.0.1:3000" + path
		if r.URL.RawQuery != "" {
			url += "?" + r.URL.RawQuery
		}
		req, err := http.NewRequest(r.Method, url, r.Body)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		for k, vv := range r.Header {
			for _, v := range vv {
				req.Header.Add(k, v)
			}
		}
		client := &http.Client{Timeout: 20 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, "control-api unreachable: "+err.Error(), 502)
			return
		}
		defer resp.Body.Close()
		for k, vv := range resp.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	})
	mux.HandleFunc("/api/desk", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/api/desk/", http.StatusTemporaryRedirect)
	})
	mux.HandleFunc("/api/logs", func(w http.ResponseWriter, r *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "no flush", 500)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		ch := make(chan string, 64)
		a.mu.Lock()
		a.subs[ch] = struct{}{}
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			delete(a.subs, ch)
			a.mu.Unlock()
			close(ch)
		}()
		fmt.Fprintf(w, "data: %s\n\n", "VS desktop gatavs. START = robotDesk · Settings = stack restart.")
		fl.Flush()
		notify := r.Context().Done()
		for {
			select {
			case <-notify:
				return
			case line := <-ch:
				fmt.Fprintf(w, "data: %s\n\n", line)
				fl.Flush()
			}
		}
	})

	ln, err := net.Listen("tcp", "127.0.0.1:"+appPort)
	if err != nil {
		return err
	}
	a.log("VS desktop http://127.0.0.1:%s  (neaizver so programmu)", appPort)
	_ = os.WriteFile(filepath.Join(a.root, "vs-panel.txt"), []byte("http://127.0.0.1:"+appPort+"\n"), 0644)
	go func() {
		time.Sleep(600 * time.Millisecond)
		openBrowser("http://127.0.0.1:" + appPort)
		a.log("Automātiski palaižu sistēmu...")
		a.runCycle()
	}()
	return http.Serve(ln, mux)
}

func (a *App) runCycle() {
	a.mu.Lock()
	if a.st.Busy {
		a.mu.Unlock()
		a.log("[WARN] jau strada — gaidi")
		return
	}
	a.st.Busy = true
	a.st.Error = ""
	a.st.Phase = "RESTART"
	a.mu.Unlock()
	defer a.set(func(s *Status) { s.Busy = false })

	if err := a.fullRestart(); err != nil {
		a.set(func(s *Status) {
			s.Error = err.Error()
			s.Phase = "KLUDA"
		})
		a.log("[KLUDA] %s", err.Error())
		return
	}
	a.set(func(s *Status) {
		s.Phase = "DARBOJAS"
		s.Running = true
		s.LocalSHA = readLocalSHA(a.root)
		s.Updated = s.LocalSHA != "" && s.LocalSHA == s.GithubSHA
	})
	a.log("[OK] sistema palaisa. NEAIZVER so paneli.")
}

func portUp(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func pipeLines(r io.Reader, emit func(string)) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		emit(sc.Text())
	}
}
