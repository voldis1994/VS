from __future__ import annotations

from PySide6.QtCore import Qt, QThread, Slot
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from monitor_app.theme import QSS
from monitor_app.worker import MonitorWorker


def _txt(v, fallback="NO DATA") -> str:
    if v is None or v == "":
        return fallback
    return str(v)


def _cell(obj, *keys):
    cur = obj
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


class MonitorWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("VS Server Monitor")
        self.resize(1600, 980)
        self.setStyleSheet(QSS)

        root = QWidget()
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        header = QFrame()
        header.setObjectName("header")
        hl = QHBoxLayout(header)
        brand_box = QVBoxLayout()
        brand = QLabel("VS CORE")
        brand.setObjectName("brand")
        sub = QLabel("VS-CORE-01")
        sub.setObjectName("sub")
        brand_box.addWidget(brand)
        brand_box.addWidget(sub)
        hl.addLayout(brand_box)
        hl.addStretch(1)
        self.live = QLabel("● DISCONNECTED")
        self.live.setObjectName("live")
        self.live.setProperty("off", "true")
        self.clock = QLabel("UTC —")
        self.ver = QLabel("VERSION —")
        self.build = QLabel("BUILD —")
        hl.addWidget(self.live)
        hl.addWidget(self.clock)
        hl.addWidget(self.ver)
        hl.addWidget(self.build)
        layout.addWidget(header)

        body = QWidget()
        grid = QGridLayout(body)
        grid.setContentsMargins(16, 16, 16, 16)
        grid.setSpacing(12)
        self.cards: dict[str, QLabel] = {}

        def card(key: str, title: str, row: int, col: int, rs: int = 1, cs: int = 1) -> None:
            f = QFrame()
            f.setObjectName("Card")
            v = QVBoxLayout(f)
            lab = QLabel(title)
            lab.setObjectName("CardLabel")
            val = QLabel("NO DATA")
            val.setObjectName("CardValue")
            val.setWordWrap(True)
            val.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
            v.addWidget(lab)
            v.addWidget(val, 1)
            self.cards[key] = val
            grid.addWidget(f, row, col, rs, cs)

        card("uptime", "UPTIME", 0, 0)
        card("system", "SYSTEM", 0, 1)
        card("database", "DATABASE", 0, 2)
        card("cache", "CACHE", 0, 3)
        card("market", "MARKET", 1, 0, 1, 2)
        card("trading", "TRADING", 1, 2, 1, 2)
        card("admin", "ADMIN", 2, 0, 1, 2)
        card("clients", "CLIENTS", 2, 2, 1, 2)
        card("incidents", "INCIDENTS", 3, 0, 1, 2)
        card("events", "RECENT EVENTS", 3, 2, 1, 2)
        layout.addWidget(body, 1)

        bar = QStatusBar()
        self.setStatusBar(bar)
        self.status_msg = QLabel("connecting to local Control API")
        bar.addWidget(self.status_msg, 1)

        self.thread = QThread(self)
        self.worker = MonitorWorker()
        self.worker.moveToThread(self.thread)
        self.thread.started.connect(self.worker.start)
        self.worker.snapshot.connect(self.on_snapshot)
        self.thread.start()

    @Slot(dict)
    def on_snapshot(self, snap: dict) -> None:
        connected = bool(snap.get("_connected"))
        self.live.setText("● LIVE READY" if connected else "● OFFLINE")
        self.live.setProperty("off", "false" if connected else "true")
        self.live.style().unpolish(self.live)
        self.live.style().polish(self.live)
        self.clock.setText(f"UTC {snap.get('_ts') or '—'}")
        self.ver.setText(f"VERSION {_txt(snap.get('server_version') or _cell(snap, 'build', 'version'))}")
        self.build.setText(f"BUILD {_txt(_cell(snap, 'build', 'build_commit'))}")
        self.cards["uptime"].setText(_txt(snap.get("uptime_human")))
        sys = snap.get("system") or {}
        self.cards["system"].setText(
            f"CPU {_txt(sys.get('cpu_percent'))}%\n"
            f"RAM {_txt(sys.get('ram_percent'))}%\n"
            f"SSD {_txt(sys.get('disk_percent'))}%\n"
            f"NET {_txt(_cell(snap, 'network', 'lan_ip') or _cell(snap, 'network', 'status'))}"
        )
        self.cards["database"].setText(
            f"PostgreSQL\n{_txt(_cell(snap, 'database', 'status'))}\n{_txt(_cell(snap, 'database', 'detail'))}"
        )
        self.cards["cache"].setText(
            f"Redis\n{_txt(_cell(snap, 'redis', 'status'))}\n{_txt(_cell(snap, 'redis', 'detail'))}"
        )
        m = snap.get("market") or {}
        feeds = snap.get("feeds") or {}
        feed_txt = "  ".join(
            f"{k}:{v.get('status') if isinstance(v, dict) else v}" for k, v in feeds.items()
        ) or "NO DATA"
        self.cards["market"].setText(
            f"{_txt(m.get('status'))}  {_txt(m.get('detail'))}\nFEEDS {feed_txt}"
        )
        tr = snap.get("trading") or {}
        st = snap.get("strategy") or {}
        ex = snap.get("execution") or {}
        self.cards["trading"].setText(
            f"strategies {_txt(st.get('status'))}\n"
            f"execution {_txt(ex.get('status'))}\n"
            f"trading {_txt(tr.get('readiness') or tr.get('detail'))}"
        )
        admin = snap.get("admin") or {}
        self.cards["admin"].setText(
            f"{'MSI CONNECTED' if admin.get('connected') else 'MSI DISCONNECTED'}\n"
            f"IP {_txt(admin.get('source_ip'))}\n"
            f"transport {_txt(admin.get('transport'))}\n"
            f"heartbeat {_txt(admin.get('last_seen_human') or admin.get('last_seen'))}"
        )
        cl = snap.get("clients") or {}
        self.cards["clients"].setText(
            f"registered {_txt(cl.get('total'), '0')}\n"
            f"online {_txt(cl.get('online'), '0')}\n"
            f"devices {len(cl.get('devices') or [])}"
        )
        errs = snap.get("errors") or []
        last = snap.get("last_error")
        if last:
            errs = [last] + list(errs)
        self.cards["incidents"].setText("NONE" if not errs else "\n".join(str(x) for x in errs[:6]))
        events = snap.get("presence_clients") or []
        if events:
            self.cards["events"].setText(
                "\n".join(
                    f"{e.get('display_name') or e.get('device_id')} {e.get('status')}"
                    for e in events[:8]
                    if isinstance(e, dict)
                )
            )
        else:
            self.cards["events"].setText("NO DATA")
        self.status_msg.setText(snap.get("_error") or ("LIVE  " + _txt(snap.get("server_id"), "VS-CORE-01")))

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
        self.worker.stop()
        self.thread.quit()
        self.thread.wait(2000)
        event.accept()
