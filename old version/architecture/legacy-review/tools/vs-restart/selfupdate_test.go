package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateDownloadedVSExe_SHA256MismatchLeavesDestUntouched(t *testing.T) {
	dir := t.TempDir()
	// Fake "current" working exe (dest) — must stay untouched on bad download
	dest := filepath.Join(dir, "VS.exe")
	good := []byte("MZ" + string(make([]byte, 1_200_000)))
	if err := os.WriteFile(dest, good, 0644); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}

	tmp := filepath.Join(dir, "VS.exe.next")
	bad := []byte("MZ" + string(make([]byte, 1_200_000)))
	bad[100] = 'X'
	if err := os.WriteFile(tmp, bad, 0644); err != nil {
		t.Fatal(err)
	}

	reason := validateDownloadedVSExe(tmp, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	if reason == "" || !contains(reason, "SHA256_MISMATCH") {
		t.Fatalf("want SHA256_MISMATCH, got %q", reason)
	}
	// Atomic replace must NOT happen on mismatch — dest unchanged
	after, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("dest VS.exe was modified after SHA mismatch — FAIL rollback invariant")
	}
}

func TestValidateDownloadedVSExe_OKWhenHashMatches(t *testing.T) {
	dir := t.TempDir()
	tmp := filepath.Join(dir, "VS.exe.next")
	payload := []byte("MZ" + string(make([]byte, 1_200_000)))
	if err := os.WriteFile(tmp, payload, 0644); err != nil {
		t.Fatal(err)
	}
	sum, _, err := fileSHA256(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if reason := validateDownloadedVSExe(tmp, sum); reason != "" {
		t.Fatalf("expected OK, got %q", reason)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		(func() bool {
			for i := 0; i+len(sub) <= len(s); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		})())
}
