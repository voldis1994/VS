#!/usr/bin/env python3
"""Offscreen grabs for docs — not physical acceptance. Shows UI chrome with NO DATA."""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
OUT = ROOT / "DOCS" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

from PySide6.QtWidgets import QApplication

from services.api import ControlApi
from ui.main_window import MainWindow, NAV


def main() -> int:
    app = QApplication([])
    win = MainWindow(ControlApi("http://127.0.0.1:9"), "LAN")
    win.resize(1440, 900)
    win.show()
    app.processEvents()
    win.on_snapshot(
        {
            "connected": False,
            "state": "DISCONNECTED",
            "transport": "LAN",
            "health": "FAILED",
            "feeds": {},
            "clients": [],
            "orders": [],
            "incidents": [],
            "events": [],
            "positions": [],
            "devices": [],
            "presenceClients": [],
        }
    )
    app.processEvents()
    win.grab().save(str(OUT / "admin-dashboard.png"))
    for name, file in (
        ("Clients", "admin-clients.png"),
        ("Trading", "admin-trading.png"),
        ("Market", "admin-market.png"),
        ("Positions", "admin-positions.png"),
    ):
        win.nav.setCurrentRow(NAV.index(name))
        app.processEvents()
        win.grab().save(str(OUT / file))
    win.close()
    sys.path.insert(0, str(ROOT / "SERVER" / "monitor"))
    from monitor_app.window import MonitorWindow

    mon = MonitorWindow()
    mon.resize(1600, 980)
    mon.show()
    app.processEvents()
    mon.grab().save(str(OUT / "server-monitor.png"))
    mon.close()
    app.processEvents()
    print("wrote", sorted(p.name for p in OUT.glob("*.png")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
