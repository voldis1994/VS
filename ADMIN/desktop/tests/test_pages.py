from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from pages.dashboard import DashboardPage
from pages.ops import PositionsPage
from pages.server import ServerPage
from pages.trading import TradingPage
from services.api import ControlApi
from ui.main_window import NAV, MainWindow


def test_nav_has_all_operator_pages():
    assert NAV == [
        "Dashboard",
        "Server",
        "Clients",
        "Accounts",
        "Market",
        "Trading",
        "Strategies",
        "Execution",
        "Positions",
        "Orders",
        "Trades",
        "Incidents",
        "Logs",
        "Backups",
        "Updates",
        "Settings",
    ]


def test_disconnected_snapshot_does_not_fake_connected():
    app = QApplication.instance() or QApplication([])
    win = MainWindow(ControlApi("http://127.0.0.1:9"), "LAN")
    win.show()
    app.processEvents()
    snap = {
        "connected": False,
        "state": "DISCONNECTED",
        "connectionPhase": "DISCONNECTED",
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
    win.on_snapshot(snap)
    app.processEvents()
    assert "● DISCONNECTED" in win.conn.text()
    assert "● CONNECTED" not in win.conn.text()
    dash = win.pages["Dashboard"]
    assert isinstance(dash, DashboardPage)
    assert dash.cards["health"].value.text() == "FAILED"
    assert isinstance(win.pages["Server"], ServerPage)
    assert isinstance(win.pages["Trading"], TradingPage)
    assert isinstance(win.pages["Positions"], PositionsPage)
    win.close()
    app.processEvents()


def test_connected_header_requires_snapshot_flag():
    app = QApplication.instance() or QApplication([])
    win = MainWindow(ControlApi("http://127.0.0.1:9"), "LAN")
    win.on_snapshot(
        {
            "connected": True,
            "state": "CONNECTED",
            "server_id": "VS-CORE-01",
            "transport": "LAN",
            "latency_ms": 12,
            "last_heartbeat": "live",
            "server_version": "1.2.3",
            "health": "HEALTHY",
            "uptime": "1h",
            "clientsOnline": 1,
            "clientsRegistered": 2,
            "openPositions": 0,
            "totalPnlToday": None,
            "feeds": {"capital": {"status": "OK"}},
            "clients": [{"name": "alpha", "access_enabled": True}],
            "orders": [{"id": "o1", "side": "BUY", "status": "FILLED"}],
            "incidents": [],
            "events": [],
            "positions": [],
            "devices": [],
            "presenceClients": [],
        }
    )
    app.processEvents()
    assert "CONNECTED" in win.conn.text()
    assert "LAN" in win.transport.text()
    dash = win.pages["Dashboard"]
    assert dash.cards["health"].value.text() == "HEALTHY"
    assert dash.cards["pnl"].value.text() == "NO DATA"
    win.close()
    app.processEvents()
