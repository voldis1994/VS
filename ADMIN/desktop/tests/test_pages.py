from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from pages.accounts import AccountsPage
from pages.dashboard import DashboardPage
from pages.ops import PositionsPage
from pages.server import ServerPage
from pages.trading import TradingPage
from pages.brokers import BrokersPage
from pages.robot import RobotPage
from services.api import ControlApi
from ui.main_window import NAV, MainWindow


def _stop_live(win: MainWindow) -> None:
    """Tests inject snapshots; do not let the LAN poller overwrite them."""
    try:
        win.worker.snapshot.disconnect()
    except Exception:
        pass
    win.worker.stop()


def test_nav_has_all_operator_pages():
    assert NAV == [
        "Dashboard",
        "Server",
        "Clients",
        "Accounts",
        "Brokers",
        "Robot",
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
    _stop_live(win)
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
    assert isinstance(win.pages["Brokers"], BrokersPage)
    assert isinstance(win.pages["Robot"], RobotPage)
    win.close()
    app.processEvents()


def test_connected_header_requires_snapshot_flag():
    app = QApplication.instance() or QApplication([])
    win = MainWindow(ControlApi("http://127.0.0.1:9"), "LAN")
    _stop_live(win)
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


def test_snapshot_applies_only_visible_page():
    app = QApplication.instance() or QApplication([])
    win = MainWindow(ControlApi("http://127.0.0.1:9"), "LAN")
    _stop_live(win)
    snap = {
        "connected": True,
        "state": "CONNECTED",
        "health": "HEALTHY",
        "clients": [{"id": 1, "name": "alpha", "account_id": 7, "panel_epic": "GOLD"}],
        "brokers": [
            {
                "id": 9,
                "client_name": "alpha",
                "broker_name": "capital_com",
                "environment": "demo",
                "enabled": True,
            }
        ],
        "orders": [],
        "incidents": [],
        "events": [],
        "positions": [],
        "devices": [],
        "presenceClients": [],
        "feeds": {},
    }
    win.on_snapshot(snap)
    app.processEvents()
    assert win.pages["Brokers"].client.count() == 0
    win.nav.setCurrentRow(NAV.index("Brokers"))
    app.processEvents()
    assert win.pages["Brokers"].client.count() >= 1
    win.close()
    app.processEvents()


def test_brokers_skips_combo_rebuild_when_clients_unchanged():
    app = QApplication.instance() or QApplication([])
    page = BrokersPage(ControlApi("http://127.0.0.1:9"))
    page.show()
    calls = {"n": 0}
    orig = page.client.clear

    def wrapped():
        calls["n"] += 1
        orig()

    page.client.clear = wrapped  # type: ignore[method-assign]
    snap = {
        "connected": True,
        "clients": [{"id": 1, "name": "alpha"}],
        "brokers": [
            {
                "id": 9,
                "client_name": "alpha",
                "broker_name": "capital_com",
                "environment": "demo",
                "enabled": True,
            }
        ],
    }
    page.apply(snap)
    page.password.setText("keep-me")
    page.apply(snap)
    app.processEvents()
    assert calls["n"] == 1
    assert page.password.text() == "keep-me"
    page.close()


def test_robot_apply_does_not_reset_lot():
    app = QApplication.instance() or QApplication([])
    page = RobotPage(ControlApi("http://127.0.0.1:9"))
    page.show()
    snap = {
        "connected": True,
        "clients": [
            {
                "id": 1,
                "name": "alpha",
                "account_id": 7,
                "panel_epic": "GOLD",
                "panel_lot_size": 0.01,
            }
        ],
        "robot_desk": {"sessions": []},
    }
    page.apply(snap)
    page.lot.setValue(0.05)
    page.apply(snap)
    app.processEvents()
    assert page.lot.value() == 0.05
    page.close()


def test_accounts_apply_keeps_search_and_panel():
    app = QApplication.instance() or QApplication([])
    page = AccountsPage(ControlApi("http://127.0.0.1:9"))
    page.show()
    snap = {
        "connected": True,
        "clients": [
            {
                "id": 1,
                "name": "alpha",
                "account_id": 7,
                "panel_epic": "GOLD",
                "panel_lot_size": 0.01,
            }
        ],
    }
    page.apply(snap)
    page.table.selectRow(0)
    app.processEvents()
    assert page.panel.isVisible()
    page.search.setText("gold")
    page.apply(snap)
    app.processEvents()
    assert page.panel.isVisible()
    assert page.search.text() == "gold"
    page.close()
