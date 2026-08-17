# Startup audit

## i3

```
sudo bash START_I3
  → SERVER/MAKE_IT_WORK.sh
  → VS CORE + Control API :3000
  → Client gateway :443
  → vs-monitor  (native PySide6 GUI if DISPLAY, else TUI)
```

## MSI

```
START_MSI.bat
  → require ADMIN/config/SERVER_IP.txt
  → require /health service=VS-CORE server_id=VS-CORE-01
  → if VS Admin.exe missing → ADMIN/windows/BUILD_ADMIN.bat
  → if VS Admin.exe already running → focus existing window
  → launch one VS Admin.exe
  → native Control Panel (no browser, no :5188, no :5173)
```

## CLIENT

```
browser → stable HTTPS URL :443 → login → CLIENT web
```

This is the only web UI.
