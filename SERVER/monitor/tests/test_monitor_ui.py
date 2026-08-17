from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from monitor_app.window import MonitorWindow


def test_monitor_window_launches():
    app = QApplication.instance() or QApplication([])
    win = MonitorWindow()
    win.show()
    app.processEvents()
    assert win.windowTitle() == "VS Server Monitor"
    assert "LIVE" in win.live.text() or "OFFLINE" in win.live.text() or "DISCONNECTED" in win.live.text()
    win.on_snapshot({"_connected": True, "_ts": "now", "uptime_human": "1h", "system": {}, "admin": {"connected": True}})
    app.processEvents()
    assert "LIVE READY" in win.live.text()
    win.on_snapshot({"_connected": False, "_ts": "now"})
    app.processEvents()
    assert "OFFLINE" in win.live.text()
    win.close()
    app.processEvents()
