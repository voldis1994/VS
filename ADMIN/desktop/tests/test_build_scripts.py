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


def test_start_msi_opens_web_panel_on_this_pc():
    bat = (ROOT / "START_MSI.bat").read_text(encoding="utf-8", errors="replace")
    ps1 = (ROOT / "ADMIN" / "windows" / "start-admin.ps1").read_text(encoding="utf-8", errors="replace")
    assert "start-admin.ps1" in bat
    assert "ADMIN\\web\\index.html" in bat or "ADMIN\\web" in bat
    assert "3000/admin" in ps1
    assert "vs-calc" in ps1
    assert "VS_SINGLE_BOX" in ps1
    assert "CONNECT_FORCE.bat" not in bat
    assert "5188" not in ps1
    assert "5188" not in bat
    assert "5173" not in ps1
    assert "serve-admin" not in ps1
    assert "vite --host" not in ps1.lower()
    combo = bat + ps1
    assert "chrome" not in combo.lower()
    assert "msedge" not in combo.lower()
    assert ps1.count("{") == ps1.count("}")
    assert "Resolve-LanServerUrl" not in ps1
    assert (ROOT / "ADMIN" / "web" / "index.html").is_file()
    assert (ROOT / "SERVER" / "calc" / "vs-calc.cpp").is_file()
    assert (ROOT / "PALAID.bat").is_file()
    # Screenshot 18.08: NODE_ENV=production hid vite; API died before :3000 listen.
    assert "Remove-Item Env:NODE_ENV" in ps1
    assert "--include=dev" in ps1
    assert "node_modules\\vite\\bin\\vite.js" in ps1
    assert '@("down", "-v")' in ps1
    assert "DB_AUTH_FAILED" in ps1
    assert "Get-Content" in ps1
    assert "-lt 90" in ps1
    assert "Admin panel will still open" in ps1
    assert "npm run build" not in ps1
