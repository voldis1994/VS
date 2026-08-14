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
	"strconv"
	"strings"
	"time"
)

// Primary: GitHub Contents API (bypasses stale raw.githubusercontent.com CDN).
const githubVSExeAPI = "https://api.github.com/repos/voldis1994/VS/contents/VS.exe?ref=main"
const githubVSManifestAPI = "https://api.github.com/repos/voldis1994/VS/contents/VS.exe.sha256?ref=main"

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

	expectHash, _, err := fetchVSExeManifest(root, logfn)
	if err != nil {
		logfn("[WARN] self-update manifest: %s — turpinu bez SHA pin", err.Error())
	}
	if expectHash != "" && expectHash == curSum {
		logfn("[OK] VS.exe jau sakrīt ar main SHA256 (%d bytes)", curSize)
		return false
	}

	tmp := filepath.Join(root, "VS.exe.next")
	_ = os.Remove(tmp)
	logfn("[..] lejupielādēju VS.exe caur GitHub API...")
	if err := downloadFile(githubVSExeAPI, tmp); err != nil {
		logfn("[WARN] self-update DOWNLOAD_FAILED: %s — turpinu ar esošo VS.exe", err.Error())
		return false
	}
	if reason := validateDownloadedVSExe(tmp, expectHash); reason != "" {
		_ = os.Remove(tmp)
		logfn("[WARN] self-update %s — turpinu ar esošo VS.exe", reason)
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
	bak := filepath.Join(root, "VS.exe.bak")
	_ = copyFile(dest, bak)
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

func fetchVSExeManifest(root string, logfn func(string, ...any)) (hash string, size int64, err error) {
	tmp := filepath.Join(root, "VS.exe.sha256.download")
	_ = os.Remove(tmp)
	if err := downloadFile(githubVSManifestAPI, tmp); err != nil {
		return "", 0, err
	}
	defer os.Remove(tmp)
	b, err := os.ReadFile(tmp)
	if err != nil {
		return "", 0, err
	}
	_ = os.WriteFile(filepath.Join(root, "VS.exe.sha256"), b, 0644)
	hash, size = parseVSExeManifest(string(b))
	if hash == "" {
		return "", 0, fmt.Errorf("empty manifest hash")
	}
	logfn("[OK] manifest SHA256=%s size=%d", hash, size)
	return hash, size, nil
}

func parseVSExeManifest(text string) (hash string, size int64) {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var cleaned []string
	for _, ln := range lines {
		ln = strings.TrimSpace(ln)
		if ln != "" {
			cleaned = append(cleaned, ln)
		}
	}
	if len(cleaned) >= 1 {
		hash = strings.ToLower(strings.Fields(cleaned[0])[0])
	}
	if len(cleaned) >= 2 {
		if n, err := strconv.ParseInt(cleaned[1], 10, 64); err == nil {
			size = n
		}
	}
	return hash, size
}

// validateDownloadedVSExe returns empty string if OK, else a precise reason code.
func validateDownloadedVSExe(path, expectHash string) string {
	st, err := os.Stat(path)
	if err != nil {
		return "DOWNLOADED_FILE_MISSING"
	}
	if st.Size() < 1_000_000 {
		return fmt.Sprintf("DOWNLOADED_FILE_SIZE_INVALID (bytes=%d — ticami HTML)", st.Size())
	}
	if st.Size() > 80_000_000 {
		return fmt.Sprintf("DOWNLOADED_FILE_SIZE_INVALID (bytes=%d — parak liels)", st.Size())
	}
	if !isPEMZ(path) {
		return "NOT_VALID_PE_EXECUTABLE (nav MZ header)"
	}
	sum, _, err := fileSHA256(path)
	if err != nil {
		return "SHA256_READ_FAILED"
	}
	if expectHash != "" && sum != expectHash {
		return fmt.Sprintf("SHA256_MISMATCH (got %s want %s)", sum, expectHash)
	}
	return ""
}

func isPEMZ(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var hdr [2]byte
	if _, err := io.ReadFull(f, hdr[:]); err != nil {
		return false
	}
	return hdr[0] == 'M' && hdr[1] == 'Z'
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

func sizeOr0(st os.FileInfo) int64 {
	if st == nil {
		return 0
	}
	return st.Size()
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
