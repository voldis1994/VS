from __future__ import annotations

import os
import socket
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from services.api import ControlApi
from ui.main_window import MainWindow


def _listening(port: int) -> bool:
    s = socket.socket()
    s.settimeout(0.2)
    try:
        s.connect(("127.0.0.1", port))
        s.close()
        return True
    except OSError:
        return False


def test_admin_does_not_listen_5173_or_5188(qapp=None):
    app = QApplication.instance() or QApplication([])
    win = MainWindow(ControlApi("http://127.0.0.1:9"), "LAN")
    win.show()
    app.processEvents()
    time.sleep(0.3)
    app.processEvents()
    assert _listening(5173) is False
    assert _listening(5188) is False
    win.close()
    app.processEvents()
