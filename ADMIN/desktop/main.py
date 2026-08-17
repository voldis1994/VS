#!/usr/bin/env python3
"""VS Admin — native Windows operator console (PySide6). No browser. No local UI port."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "1")

from PySide6.QtWidgets import QApplication, QMessageBox

from app.single_instance import SingleInstance, focus_existing_window
from app.version import ADMIN_VERSION, PRODUCT_NAME
from services.api import ControlApi, default_admin_token, default_server_url, default_transport
from ui.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName(PRODUCT_NAME)
    app.setApplicationVersion(ADMIN_VERSION)
    app.setOrganizationName("VS")

    guard = SingleInstance()
    if not guard.acquire():
        focus_existing_window()
        QMessageBox.information(
            None,
            PRODUCT_NAME,
            "VS Admin is already running. Focusing the existing window.",
        )
        return 0

    url = default_server_url()
    token = default_admin_token()
    window = MainWindow(ControlApi(url, token), default_transport())
    window.show()
    code = app.exec()
    guard.release()
    return int(code)


if __name__ == "__main__":
    raise SystemExit(main())
