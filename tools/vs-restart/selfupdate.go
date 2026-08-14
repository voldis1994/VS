package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

const githubVSExe = "https://github.com/voldis1994/VS/raw/refs/heads/main/VS.exe"
const githubVSExeAlt = "https://github.com/voldis1994/VS/raw/main/VS.exe"
const githubVSExeCDN = "https://raw.githubusercontent.com/voldis1994/VS/main/VS.exe"

// maybeSelfUpdate downloads latest VS.exe. If different from this process, replaces and restarts.
// Returns true when this process should exit (new exe was spawned).
func maybeSelfUpdate(root string, logfn func(string, ...any)) bool {
	if runtime.GOOS != "windows" {
		return false
	}
	if os.Getenv("VS_NO_SELF_UPDATE") == "1" {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return false
	}
	curSum, curSize, err := fileSHA256(exe)
	if err != nil {
		logfn("[WARN] self-update: nevaru lasīt esošo VS.exe: %s", err.Error())
		return false
	}
	tmp := filepath.Join(root, "VS.exe.next")
	_ = os.Remove(tmp)
	logfn("[..] lejupielādēju jaunāko VS.exe (lai palaižējs nebūtu vecāks par kodu)...")
	if err := downloadFilePrefer(tmp, githubVSExe, githubVSExeAlt, githubVSExeCDN); err != nil {
		logfn("[WARN] self-update: %s — turpinu ar esošo VS.exe", err.Error())
		return false
	}
	st, err := os.Stat(tmp)
	if err != nil || st.Size() < 6_013_000 {
		_ = os.Remove(tmp)
		logfn("[WARN] self-update: lejupielāde pārāk maza / CDN vecs fails (%v)", err)
		return false
	}
	newSum, newSize, err := fileSHA256(tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return false
	}
	if newSum == curSum {
		_ = os.Remove(tmp)
		logfn("[OK] VS.exe jau jaunākais (%d bytes)", curSize)
		return false
	}
	logfn("[..] VS.exe atšķiras (vecais %d → jaunais %d) — pārstartēju palaižēju...", curSize, newSize)
	dest := filepath.Join(root, "VS.exe")
	// Delayed replace: this process holds the old image; cmd swaps after we exit.
	cmd := exec.Command("cmd", "/c",
		fmt.Sprintf("timeout /t 2 /nobreak >nul & move /y \"%s\" \"%s\" >nul & start \"\" \"%s\" \"%s\"",
			tmp, dest, dest, root))
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		logfn("[WARN] self-update restart: %s", err.Error())
		_ = os.Remove(tmp)
		return false
	}
	logfn("[OK] jaunais VS.exe startēsies pēc 2s — aizveru veco")
	time.Sleep(400 * time.Millisecond)
	return true
}

func downloadFilePrefer(dest string, urls ...string) error {
	var last error
	for _, u := range urls {
		if err := downloadFile(u, dest); err != nil {
			last = err
			continue
		}
		return nil
	}
	return last
}

func fileSHA256(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
