#!/usr/bin/env python3
"""VS Server Monitor — native Linux operations dashboard for the i3 display.

Primary: PySide6 GUI when a graphical session exists.
Fallback: quality TUI (no browser, no HTML page).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def has_display() -> bool:
    if os.environ.get("VS_MONITOR_TUI") == "1":
        return False
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def run_gui() -> int:
    os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "1")
    from PySide6.QtWidgets import QApplication

    from monitor_app.window import MonitorWindow

    app = QApplication(sys.argv)
    app.setApplicationName("VS Server Monitor")
    app.setOrganizationName("VS")
    win = MonitorWindow()
    win.show()
    return int(app.exec())


def main() -> int:
    if has_display():
        try:
            return run_gui()
        except Exception as e:
            print(f"GUI unavailable ({e}) — TUI fallback", file=sys.stderr)
    from monitor_app.tui import run_tui

    return run_tui()


if __name__ == "__main__":
    raise SystemExit(main())
