package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func TestListeningPIDs(t *testing.T) {
	out := "" +
		"TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING    4242\r\n" +
		"TCP    0.0.0.0:18080      0.0.0.0:0    LISTENING    99\r\n"
	got := listeningPIDs(out, "3000")
	if len(got) != 1 || got[0] != "4242" {
		t.Fatalf("got %#v", got)
	}
}

func TestCopyTreeKeepsEnv(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	_ = os.MkdirAll(filepath.Join(src, "apps", "dashboard"), 0755)
	_ = os.WriteFile(filepath.Join(src, "apps", "dashboard", "package.json"), []byte("{}"), 0644)
	_ = os.WriteFile(filepath.Join(src, ".env"), []byte("FROM_ZIP=1\n"), 0644)
	_ = os.WriteFile(filepath.Join(dst, ".env"), []byte("KEEP=1\n"), 0644)
	if err := copyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dst, ".env"))
	if string(b) != "KEEP=1\n" {
		t.Fatalf("env overwritten: %q", b)
	}
	if _, err := os.Stat(filepath.Join(dst, "apps", "dashboard", "package.json")); err != nil {
		t.Fatal(err)
	}
}

func TestUnzip(t *testing.T) {
	dir := t.TempDir()
	zp := filepath.Join(dir, "a.zip")
	f, err := os.Create(zp)
	if err != nil {
		t.Fatal(err)
	}
	w := zip.NewWriter(f)
	fw, err := w.Create("VS-main/apps/dashboard/package.json")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write([]byte(`{"name":"x"}`))
	fw2, err := w.Create("VS-main/apps/control-api/package.json")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw2.Write([]byte(`{"name":"api"}`))
	_ = w.Close()
	_ = f.Close()
	dest := filepath.Join(dir, "out")
	if err := unzip(zp, dest); err != nil {
		t.Fatal(err)
	}
	root := findVSRoot(dest)
	if root == "" {
		t.Fatal("did not find VS root")
	}
}

func TestLooksRealSecret(t *testing.T) {
	if looksRealSecret("") || looksRealSecret("CHANGE_ME_PIPELINE_TOKEN") {
		t.Fatal("placeholders must be rejected")
	}
	if !looksRealSecret("real-token-value") {
		t.Fatal("real secret rejected")
	}
}

func TestIpv4LocalDBHost(t *testing.T) {
	dir := t.TempDir()
	if got := ipv4LocalDBHost(dir); got != "127.0.0.1" {
		t.Fatalf("empty env: %s", got)
	}
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("DB_HOST=localhost\n"), 0644)
	if got := ipv4LocalDBHost(dir); got != "127.0.0.1" {
		t.Fatalf("localhost: %s", got)
	}
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("DB_HOST=10.0.0.5\n"), 0644)
	if got := ipv4LocalDBHost(dir); got != "10.0.0.5" {
		t.Fatalf("remote: %s", got)
	}
}

func TestLoadDotEnv(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("PIPELINE_TOKEN=abc\n# c\nDB_PASSWORD=secret\n"), 0644)
	m := loadDotEnv(dir)
	if m["PIPELINE_TOKEN"] != "abc" || m["DB_PASSWORD"] != "secret" {
		t.Fatalf("%v", m)
	}
}
