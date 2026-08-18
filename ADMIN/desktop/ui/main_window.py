from __future__ import annotations

from PySide6.QtCore import Slot
from PySide6.QtGui import QAction, QCloseEvent
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QStackedWidget,
    QStatusBar,
    QSystemTrayIcon,
    QVBoxLayout,
    QWidget,
)

from app.version import ADMIN_VERSION
from pages.accounts import AccountsPage
from pages.brokers import BrokersPage
from pages.clients import ClientsPage
from pages.dashboard import DashboardPage
from pages.logs import BackupsPage, LogsPage, SettingsPage, UpdatesPage
from pages.market import MarketPage
from pages.ops import IncidentsPage, OrdersPage, PositionsPage, TradesPage
from pages.robot import RobotPage
from pages.server import ServerPage
from pages.trading import ExecutionPage, StrategiesPage, TradingPage
from services.api import ControlApi
from services.live import start_live_thread
from services.ws import RealtimeSocket
from ui.format import nd
from ui.theme import APP_QSS

NAV = [
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


def _chip(text: str) -> QLabel:
    lab = QLabel(text)
    lab.setObjectName("chip")
    return lab


class MainWindow(QMainWindow):
    def __init__(self, api: ControlApi, transport: str = "LAN") -> None:
        super().__init__()
        self.api = api
        self._last: dict = {}
        self.setWindowTitle("VS Admin")
        self.resize(1480, 920)
        self.setMinimumSize(1180, 740)
        self.setStyleSheet(APP_QSS)

        root = QWidget()
        self.setCentralWidget(root)
        layout = QHBoxLayout(root)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        sidebar = QWidget()
        sidebar.setObjectName("sidebar")
        sidebar.setFixedWidth(214)
        sl = QVBoxLayout(sidebar)
        sl.setContentsMargins(16, 18, 12, 12)
        brand = QLabel("VS")
        brand.setObjectName("sideBrand")
        sub = QLabel("ADMIN")
        sub.setObjectName("sideSub")
        sl.addWidget(brand)
        sl.addWidget(sub)
        self.nav = QListWidget()
        self.nav.setObjectName("nav")
        for name in NAV:
            self.nav.addItem(QListWidgetItem(name.upper()))
        sl.addWidget(self.nav, 1)
        layout.addWidget(sidebar)

        right = QWidget()
        right_l = QVBoxLayout(right)
        right_l.setContentsMargins(0, 0, 0, 0)
        right_l.setSpacing(0)

        header = QFrame()
        header.setObjectName("header")
        hl = QHBoxLayout(header)
        self.brand = QLabel("CONTROL PANEL")
        self.brand.setObjectName("brand")
        self.server_id = _chip("VS-CORE-01")
        self.conn = _chip("● DISCONNECTED")
        self.transport = _chip("TRANSPORT —")
        self.latency = _chip("LATENCY —")
        self.hb = _chip("LAST HEARTBEAT —")
        self.sver = _chip("SERVER —")
        self.aver = _chip(f"ADMIN {ADMIN_VERSION}")
        hl.addWidget(self.brand)
        hl.addWidget(self.server_id)
        hl.addStretch(1)
        for w in (self.conn, self.transport, self.latency, self.hb, self.sver, self.aver):
            hl.addWidget(w)
        right_l.addWidget(header)

        self.stack = QStackedWidget()
        self.pages: dict[str, QWidget] = {
            "Dashboard": DashboardPage(),
            "Server": ServerPage(),
            "Clients": ClientsPage(self.api),
            "Accounts": AccountsPage(self.api),
            "Brokers": BrokersPage(self.api),
            "Robot": RobotPage(self.api),
            "Market": MarketPage(),
            "Trading": TradingPage(),
            "Strategies": StrategiesPage(),
            "Execution": ExecutionPage(),
            "Positions": PositionsPage(),
            "Orders": OrdersPage(),
            "Trades": TradesPage(),
            "Incidents": IncidentsPage(),
            "Logs": LogsPage(),
            "Backups": BackupsPage(),
            "Updates": UpdatesPage(),
            "Settings": SettingsPage(),
        }
        for name in NAV:
            self.stack.addWidget(self.pages[name])
        right_l.addWidget(self.stack, 1)
        layout.addWidget(right, 1)

        status = QStatusBar()
        self.setStatusBar(status)
        self.status_msg = QLabel("Connecting to VS CORE…")
        status.addWidget(self.status_msg, 1)

        self.nav.currentRowChanged.connect(self._on_nav)
        self.nav.setCurrentRow(0)

        self.thread, self.worker = start_live_thread(self.api, transport)
        self.worker.snapshot.connect(self.on_snapshot)
        self.thread.start()

        self.ws = RealtimeSocket(self.api.base, self)
        self.ws.opened.connect(lambda: self.worker.mark_ws(True))
        self.ws.closed.connect(lambda _m: self.worker.mark_ws(False))
        self.ws.open()

        raise_act = QAction("Show VS Admin", self)
        raise_act.triggered.connect(self.raise_window)
        self.addAction(raise_act)

        if QSystemTrayIcon.isSystemTrayAvailable():
            self.tray = QSystemTrayIcon(self)
            self.tray.setToolTip("VS Admin")
            self.tray.activated.connect(lambda *_: self.raise_window())
        else:
            self.tray = None

    def _visible_page(self) -> QWidget | None:
        row = self.nav.currentRow()
        if row < 0 or row >= len(NAV):
            return None
        return self.pages.get(NAV[row])

    def _apply_page(self, page: QWidget | None, snap: dict) -> None:
        apply = getattr(page, "apply", None)
        if callable(apply):
            apply(snap)

    def _on_nav(self, row: int) -> None:
        self.stack.setCurrentIndex(row)
        if self._last:
            name = NAV[row] if 0 <= row < len(NAV) else None
            self._apply_page(self.pages.get(name) if name else None, self._last)

    def raise_window(self) -> None:
        self.show()
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def _set_chip(self, widget: QLabel, text: str, tone: str = "neutral") -> None:
        widget.setText(text)
        widget.setProperty("tone", tone)
        widget.style().unpolish(widget)
        widget.style().polish(widget)

    @Slot(dict)
    def on_snapshot(self, snap: dict) -> None:
        self._last = snap
        state = str(snap.get("state") or snap.get("connectionPhase") or "DISCONNECTED")
        tone = {"CONNECTED": "ok", "RECONNECTING": "warn", "DISCONNECTED": "bad"}.get(state, "neutral")
        self._set_chip(self.conn, f"● {state}", tone)
        self.server_id.setText(str(snap.get("server_id") or snap.get("serverId") or "VS-CORE-01"))
        self.transport.setText(f"TRANSPORT {snap.get('transport') or '—'}")
        lat = snap.get("latency_ms") if snap.get("latency_ms") is not None else snap.get("latencyMs")
        self.latency.setText(f"LATENCY {lat} ms" if lat is not None else "LATENCY —")
        self.hb.setText(f"LAST HEARTBEAT {snap.get('last_heartbeat') or '—'}")
        self.sver.setText(f"SERVER {snap.get('server_version') or snap.get('serverVersion') or '—'}")
        self.status_msg.setText(str(snap.get("error") or f"{state} · {nd(snap.get('url'), '')}"))
        self._apply_page(self._visible_page(), snap)

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
        try:
            self.ws.close()
        except Exception:
            pass
        self.worker.stop()
        self.thread.quit()
        self.thread.wait(3000)
        event.accept()
