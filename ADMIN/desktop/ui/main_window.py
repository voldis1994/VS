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
from pages.clients import ClientsPage
from pages.dashboard import DashboardPage
from pages.logs import LogsPage
from pages.resource import ResourcePage
from pages.settings import SettingsPage
from services.api import ControlApi
from services.live import start_live_thread
from services.ws import RealtimeSocket
from ui.theme import APP_QSS

NAV = [
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


class MainWindow(QMainWindow):
    def __init__(self, api: ControlApi, transport: str = "LAN") -> None:
        super().__init__()
        self.api = api
        self.setWindowTitle("VS Admin")
        self.resize(1440, 900)
        self.setMinimumSize(1100, 720)
        self.setStyleSheet(APP_QSS)

        root = QWidget()
        self.setCentralWidget(root)
        layout = QHBoxLayout(root)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self.nav = QListWidget()
        self.nav.setObjectName("nav")
        self.nav.setFixedWidth(210)
        for name in NAV:
            self.nav.addItem(QListWidgetItem(name.upper()))
        layout.addWidget(self.nav)

        right = QWidget()
        right_l = QVBoxLayout(right)
        right_l.setContentsMargins(0, 0, 0, 0)
        right_l.setSpacing(0)

        header = QFrame()
        header.setObjectName("header")
        hl = QHBoxLayout(header)
        self.brand = QLabel("VS ADMIN")
        self.brand.setObjectName("brand")
        self.server_id = QLabel("VS-CORE-01")
        self.server_id.setObjectName("chip")
        self.conn = QLabel("● DISCONNECTED")
        self.conn.setObjectName("chip")
        self.transport = QLabel("TRANSPORT —")
        self.transport.setObjectName("chip")
        self.latency = QLabel("LATENCY —")
        self.latency.setObjectName("chip")
        self.hb = QLabel("LAST HEARTBEAT —")
        self.hb.setObjectName("chip")
        self.sver = QLabel("SERVER —")
        self.sver.setObjectName("chip")
        self.aver = QLabel(f"ADMIN {ADMIN_VERSION}")
        self.aver.setObjectName("chip")
        hl.addWidget(self.brand)
        hl.addWidget(self.server_id)
        hl.addStretch(1)
        for w in (self.conn, self.transport, self.latency, self.hb, self.sver, self.aver):
            hl.addWidget(w)
        right_l.addWidget(header)

        self.stack = QStackedWidget()
        self.pages: dict[str, QWidget] = {
            "Dashboard": DashboardPage(),
            "Server": ResourcePage("SERVER"),
            "Clients": ClientsPage(self.api),
            "Accounts": AccountsPage(),
            "Market": ResourcePage("MARKET"),
            "Trading": ResourcePage("TRADING"),
            "Strategies": ResourcePage("STRATEGIES"),
            "Execution": ResourcePage("EXECUTION"),
            "Positions": ResourcePage("POSITIONS"),
            "Orders": ResourcePage("ORDERS"),
            "Trades": ResourcePage("TRADES"),
            "Incidents": ResourcePage("INCIDENTS"),
            "Logs": LogsPage(),
            "Backups": ResourcePage("BACKUPS"),
            "Updates": ResourcePage("UPDATES"),
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

        self.nav.currentRowChanged.connect(self.stack.setCurrentIndex)
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

        self._last: dict = {}

    def raise_window(self) -> None:
        self.show()
        self.showNormal()
        self.raise_()
        self.activateWindow()

    @Slot(dict)
    def on_snapshot(self, snap: dict) -> None:
        self._last = snap
        state = str(snap.get("state") or snap.get("connectionPhase") or "DISCONNECTED")
        self.conn.setText(f"● {state}")
        color = {"CONNECTED": "#3DDC97", "RECONNECTING": "#E8B84A", "DISCONNECTED": "#FF5C7A"}.get(state, "#8B93A7")
        self.conn.setStyleSheet(f"color:{color};")
        self.server_id.setText(str(snap.get("server_id") or snap.get("serverId") or "VS-CORE-01"))
        self.transport.setText(f"TRANSPORT {snap.get('transport') or '—'}")
        lat = snap.get("latency_ms") if snap.get("latency_ms") is not None else snap.get("latencyMs")
        self.latency.setText(f"LATENCY {lat} ms" if lat is not None else "LATENCY —")
        self.hb.setText(f"LAST HEARTBEAT {snap.get('last_heartbeat') or '—'}")
        self.sver.setText(f"SERVER {snap.get('server_version') or snap.get('serverVersion') or '—'}")
        self.status_msg.setText(str(snap.get("error") or f"{state} · {snap.get('url') or ''}"))
        for page in self.pages.values():
            apply = getattr(page, "apply", None)
            if callable(apply):
                apply(snap)

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
        try:
            self.ws.close()
        except Exception:
            pass
        self.worker.stop()
        self.thread.quit()
        self.thread.wait(3000)
        event.accept()
