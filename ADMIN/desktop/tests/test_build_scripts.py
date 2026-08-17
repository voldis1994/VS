from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_canonical_build_script_exists():
    bat = ROOT / "ADMIN" / "windows" / "BUILD_ADMIN.bat"
    assert bat.is_file()
    text = bat.read_text(encoding="utf-8", errors="replace")
    assert "VS Admin.exe" in text or "VS Admin" in text
    assert "PyInstaller" in text or "pyinstaller" in text
    assert not (ROOT / "ADMIN" / "windows" / "BUILD_ADMIN_NEW.bat").exists()
    assert not (ROOT / "ADMIN" / "windows" / "BUILD_ADMIN_FINAL.bat").exists()
    assert not (ROOT / "ADMIN" / "windows" / "BUILD_V2.bat").exists()
    assert not (ROOT / "ADMIN" / "desktop" / "pages" / "resource.py").exists()
    assert (ROOT / "ADMIN" / "desktop" / "main.py").is_file()
    assert (ROOT / "ADMIN" / "desktop" / "ui" / "main_window.py").is_file()
    bat = ROOT / "ADMIN" / "windows" / "BUILD_ADMIN.bat"
    assert bat.is_file()
    text = bat.read_text(encoding="utf-8", errors="replace")
    assert "VS Admin.exe" in text or "VS Admin" in text
    assert "PyInstaller" in text or "pyinstaller" in text
    assert not (ROOT / "ADMIN" / "windows" / "BUILD_ADMIN_NEW.bat").exists()
    assert not (ROOT / "ADMIN" / "windows" / "BUILD_ADMIN_FINAL.bat").exists()
    assert not (ROOT / "ADMIN" / "windows" / "BUILD_V2.bat").exists()


def test_start_msi_launches_native_exe_not_browser():
    bat = (ROOT / "START_MSI.bat").read_text(encoding="utf-8", errors="replace")
    ps1 = (ROOT / "ADMIN" / "windows" / "start-admin.ps1").read_text(encoding="utf-8", errors="replace")
    assert "start-admin.ps1" in bat
    assert "VS Admin.exe" in ps1
    assert "5188" not in ps1
    assert "5173" not in ps1
    assert "serve-admin" not in ps1
    assert "vite --host" not in ps1.lower()
    assert "npm exec" not in ps1.lower()
    assert "Start-Process http" not in ps1
    combo = bat + ps1
    assert "chrome" not in combo.lower()
    assert "msedge" not in combo.lower()
