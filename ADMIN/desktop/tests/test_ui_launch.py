from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from app.single_instance import SingleInstance
from services.api import ControlApi
from ui.main_window import MainWindow, NAV


def test_single_instance_lock(tmp_path, monkeypatch):
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    a = SingleInstance()
    b = SingleInstance()
    assert a.acquire() is True
    assert b.acquire() is False
    a.release()
    assert b.acquire() is True
    b.release()


def test_window_launches_and_has_nav():
    app = QApplication.instance() or QApplication([])
    win = MainWindow(ControlApi("http://127.0.0.1:9"), "LAN")
    win.show()
    app.processEvents()
    assert win.windowTitle() == "VS Admin"
    assert win.nav.count() == len(NAV)
    assert "●" in win.conn.text()
    win.close()
    app.processEvents()
