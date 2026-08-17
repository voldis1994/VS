#!/usr/bin/env python3
"""VS Server Monitor — native Linux operations dashboard for the i3 display."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "1")

from PySide6.QtWidgets import QApplication

from monitor_app.window import MonitorWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("VS Server Monitor")
    app.setOrganizationName("VS")
    win = MonitorWindow()
    win.show()
    return int(app.exec())


if __name__ == "__main__":
    raise SystemExit(main())
