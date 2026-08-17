from __future__ import annotations

from PySide6.QtCore import QThread, Slot
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

from monitor_app.chrome import KpiCard, Kv, MetricBar, Panel, VsTable, cell, nd, tone_for
from monitor_app.theme import QSS
from monitor_app.worker import MonitorWorker


class MonitorWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("VS Server Monitor")
        self.resize(1680, 1000)
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
        self.clock.setObjectName("chip")
        self.ver = QLabel("VERSION —")
        self.ver.setObjectName("chip")
        self.build = QLabel("BUILD —")
        self.build.setObjectName("chip")
        hl.addWidget(self.live)
        hl.addWidget(self.clock)
        hl.addWidget(self.ver)
        hl.addWidget(self.build)
        layout.addWidget(header)

        body = QWidget()
        grid = QGridLayout(body)
        grid.setContentsMargins(16, 16, 16, 16)
        grid.setSpacing(12)

        self.uptime = KpiCard("UPTIME")
        self.cpu_card = KpiCard("CPU")
        self.ram_card = KpiCard("RAM")
        self.ssd_card = KpiCard("SSD")
        grid.addWidget(self.uptime, 0, 0)
        grid.addWidget(self.cpu_card, 0, 1)
        grid.addWidget(self.ram_card, 0, 2)
        grid.addWidget(self.ssd_card, 0, 3)

        sys = Panel("SYSTEM")
        self.cpu = MetricBar("CPU")
        self.ram = MetricBar("RAM")
        self.ssd = MetricBar("SSD")
        self.net = QLabel("NETWORK  NO DATA")
        self.net.setObjectName("muted")
        sys.body.addWidget(self.cpu)
        sys.body.addWidget(self.ram)
        sys.body.addWidget(self.ssd)
        sys.body.addWidget(self.net)
        grid.addWidget(sys, 1, 0)

        db = Panel("DATABASE")
        self.db_status = Kv("POSTGRESQL")
        self.db_detail = Kv("DETAIL")
        db.body.addWidget(self.db_status)
        db.body.addWidget(self.db_detail)
        cache = Panel("CACHE")
        self.redis_status = Kv("REDIS")
        self.redis_detail = Kv("DETAIL")
        cache.body.addWidget(self.redis_status)
        cache.body.addWidget(self.redis_detail)
        stack = QVBoxLayout()
        stack.addWidget(db)
        stack.addWidget(cache)
        wrap = QWidget()
        wrap.setLayout(stack)
        grid.addWidget(wrap, 1, 1)

        market = Panel("MARKET")
        self.m_status = Kv("STATE")
        self.m_detail = Kv("DETAIL")
        self.m_feeds = Kv("FEEDS")
        market.body.addWidget(self.m_status)
        market.body.addWidget(self.m_detail)
        market.body.addWidget(self.m_feeds)
        grid.addWidget(market, 1, 2)

        trading = Panel("TRADING")
        self.t_strat = Kv("STRATEGIES")
        self.t_exec = Kv("EXECUTION")
        self.t_pos = Kv("POSITIONS")
        self.t_ord = Kv("ORDERS")
        self.t_ready = Kv("READY")
        for w in (self.t_strat, self.t_exec, self.t_pos, self.t_ord, self.t_ready):
            trading.body.addWidget(w)
        grid.addWidget(trading, 1, 3)

        admin = Panel("ADMIN")
        self.a_conn = Kv("MSI")
        self.a_ip = Kv("MSI IP")
        self.a_tr = Kv("TRANSPORT")
        self.a_hb = Kv("HEARTBEAT")
        for w in (self.a_conn, self.a_ip, self.a_tr, self.a_hb):
            admin.body.addWidget(w)
        grid.addWidget(admin, 2, 0, 1, 2)

        clients = Panel("CLIENTS")
        self.c_reg = Kv("REGISTERED")
        self.c_on = Kv("ONLINE")
        self.c_trade = Kv("TRADING")
        self.c_pause = Kv("PAUSED")
        for w in (self.c_reg, self.c_on, self.c_trade, self.c_pause):
            clients.body.addWidget(w)
        grid.addWidget(clients, 2, 2, 1, 2)

        inc = Panel("INCIDENTS")
        self.incidents = VsTable(["EVENT"], ["msg"])
        inc.body.addWidget(self.incidents, 1)
        grid.addWidget(inc, 3, 0, 1, 2)

        ev = Panel("RECENT EVENTS")
        self.events = VsTable(["CLIENT", "STATUS"], ["name", "status"])
        ev.body.addWidget(self.events, 1)
        grid.addWidget(ev, 3, 2, 1, 2)

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
        self.ver.setText(f"VERSION {nd(snap.get('server_version') or cell(snap, 'build', 'version'))}")
        self.build.setText(f"BUILD {nd(cell(snap, 'build', 'build_commit'))}")
        self.uptime.set_value(snap.get("uptime_human"), tone="ok" if connected else "bad")

        sys = snap.get("system") or {}
        cpu = sys.get("cpu_percent")
        ram = sys.get("ram_percent")
        disk = sys.get("disk_percent")
        self.cpu_card.set_value(None if cpu is None else f"{cpu:.0f}%", tone=tone_for("OK" if isinstance(cpu, (int, float)) else None))
        self.ram_card.set_value(None if ram is None else f"{ram:.0f}%")
        self.ssd_card.set_value(None if disk is None else f"{disk:.0f}%")
        self.cpu.set_value(cpu if isinstance(cpu, (int, float)) else None)
        self.ram.set_value(ram if isinstance(ram, (int, float)) else None)
        self.ssd.set_value(disk if isinstance(disk, (int, float)) else None)
        self.net.setText(f"NETWORK  {nd(cell(snap, 'network', 'lan_ip') or cell(snap, 'network', 'status'))}")

        self.db_status.set_value(cell(snap, "database", "status"), tone=tone_for(cell(snap, "database", "status")))
        self.db_detail.set_value(cell(snap, "database", "detail"))
        self.redis_status.set_value(cell(snap, "redis", "status"), tone=tone_for(cell(snap, "redis", "status")))
        self.redis_detail.set_value(cell(snap, "redis", "detail"))

        m = snap.get("market") or {}
        feeds = snap.get("feeds") or {}
        feed_txt = "  ".join(
            f"{k}:{v.get('status') if isinstance(v, dict) else v}" for k, v in feeds.items()
        ) or "NO DATA"
        self.m_status.set_value(m.get("status") or m.get("state"), tone=tone_for(m.get("status")))
        self.m_detail.set_value(m.get("detail"))
        self.m_feeds.set_value(feed_txt)

        tr = snap.get("trading") or {}
        st = snap.get("strategy") or {}
        ex = snap.get("execution") or {}
        cl = snap.get("clients") or {}
        self.t_strat.set_value(st.get("status"), tone=tone_for(st.get("status")))
        self.t_exec.set_value(ex.get("status"), tone=tone_for(ex.get("status")))
        self.t_pos.set_value(cl.get("online"))
        self.t_ord.set_value(tr.get("detail"))
        self.t_ready.set_value(tr.get("readiness"), tone=tone_for(tr.get("readiness")))

        admin = snap.get("admin") or {}
        connected_admin = bool(admin.get("connected"))
        self.a_conn.set_value("MSI CONNECTED" if connected_admin else "MSI DISCONNECTED", tone="ok" if connected_admin else "bad")
        self.a_ip.set_value(admin.get("source_ip"))
        self.a_tr.set_value(admin.get("transport"))
        self.a_hb.set_value(admin.get("last_seen_human") or admin.get("last_seen"))

        devices = cl.get("devices") or []
        trading_n = sum(1 for d in devices if isinstance(d, dict) and str(d.get("status") or "").upper() in ("TRADING", "ONLINE", "CONNECTED"))
        paused_n = sum(1 for d in devices if isinstance(d, dict) and "PAUSE" in str(d.get("status") or "").upper())
        self.c_reg.set_value(cl.get("total"), tone="ok")
        self.c_on.set_value(cl.get("online"))
        self.c_trade.set_value(trading_n)
        self.c_pause.set_value(paused_n)

        errs = list(snap.get("errors") or [])
        last = snap.get("last_error")
        if last:
            errs = [last] + errs
        self.incidents.set_rows([{"msg": str(x)} for x in errs[:12]] if errs else [])
        events = snap.get("presence_clients") or []
        self.events.set_rows(
            [
                {"name": e.get("display_name") or e.get("device_id"), "status": e.get("status")}
                for e in events
                if isinstance(e, dict)
            ]
        )
        self.status_msg.setText(snap.get("_error") or ("LIVE  " + nd(snap.get("server_id"), "VS-CORE-01")))

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
        self.worker.stop()
        self.thread.quit()
        self.thread.wait(2000)
        event.accept()
