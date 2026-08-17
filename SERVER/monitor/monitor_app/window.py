from __future__ import annotations

from PySide6.QtCore import QThread, Slot
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QScrollArea,
    QSizePolicy,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from monitor_app.chrome import KpiCard, Kv, MetricBar, Panel, VsTable, cell, nd, tone_for
from monitor_app.theme import QSS
from monitor_app.worker import MonitorWorker


def _tone(status: str | None) -> str:
    s = (status or "").upper()
    if s in ("ONLINE", "HEALTHY", "OK", "CONNECTED", "LIVE", "RUNNING", "READY"):
        return "ok"
    if s in ("DEGRADED", "WARNING", "WARN", "STARTING", "SEEDING", "DEMO", "PAPER"):
        return "warn"
    if s in ("OFFLINE", "ERROR", "CRITICAL", "FAILED", "STALE", "NO DATA", "NOT READY",
             "NOT_READY", "UNKNOWN"):
        return "bad"
    return "neutral"


class MonitorWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("VS Server Monitor")
        self.resize(1366, 768)
        self.setMinimumSize(1024, 600)
        self.setStyleSheet(QSS)

        root = QWidget()
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── Header ────────────────────────────────────────────────────────────
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
        self.live = QLabel("● OFFLINE")
        self.live.setObjectName("live")
        self.live.setProperty("off", "true")
        self.clock = QLabel("UTC —")
        self.clock.setObjectName("chip")
        self.ver = QLabel("VERSION —")
        self.ver.setObjectName("chip")
        self.build_lbl = QLabel("BUILD —")
        self.build_lbl.setObjectName("chip")
        hl.addWidget(self.live)
        hl.addWidget(self.clock)
        hl.addWidget(self.ver)
        hl.addWidget(self.build_lbl)
        layout.addWidget(header)

        # ── Scrollable body ───────────────────────────────────────────────────
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        body_widget = QWidget()
        body_widget.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        grid = QGridLayout(body_widget)
        grid.setContentsMargins(12, 12, 12, 12)
        grid.setSpacing(8)

        # ── Row 0: subsystem KPI cards (4 across) ─────────────────────────────
        self.kpi_core = KpiCard("CORE")
        self.kpi_capital = KpiCard("CAPITAL")
        self.kpi_feeds = KpiCard("FEEDS")
        self.kpi_ohlc = KpiCard("10s OHLC")
        grid.addWidget(self.kpi_core, 0, 0)
        grid.addWidget(self.kpi_capital, 0, 1)
        grid.addWidget(self.kpi_feeds, 0, 2)
        grid.addWidget(self.kpi_ohlc, 0, 3)

        # ── Row 1: more KPI cards ──────────────────────────────────────────────
        self.kpi_money = KpiCard("MONEY PATH")
        self.kpi_live_flag = KpiCard("LIVE ENABLED")
        self.kpi_robot = KpiCard("ROBOT")
        self.kpi_gateway = KpiCard("CLIENT GATEWAY")
        grid.addWidget(self.kpi_money, 1, 0)
        grid.addWidget(self.kpi_live_flag, 1, 1)
        grid.addWidget(self.kpi_robot, 1, 2)
        grid.addWidget(self.kpi_gateway, 1, 3)

        # ── Row 2: System | Database+Cache | Market | Trading ─────────────────
        sys_panel = Panel("SYSTEM")
        self.uptime = Kv("UPTIME")
        self.cpu = MetricBar("CPU")
        self.ram = MetricBar("RAM")
        self.ssd = MetricBar("SSD")
        self.net = QLabel("NETWORK  NO DATA")
        self.net.setObjectName("muted")
        for w in (self.uptime, self.cpu, self.ram, self.ssd, self.net):
            sys_panel.body.addWidget(w)
        grid.addWidget(sys_panel, 2, 0)

        stack_widget = QWidget()
        stack = QVBoxLayout(stack_widget)
        stack.setContentsMargins(0, 0, 0, 0)
        stack.setSpacing(8)
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
        stack.addWidget(db)
        stack.addWidget(cache)
        grid.addWidget(stack_widget, 2, 1)

        market = Panel("MARKET")
        self.m_status = Kv("STATE")
        self.m_detail = Kv("DETAIL")
        self.m_feeds = Kv("FEEDS")
        market.body.addWidget(self.m_status)
        market.body.addWidget(self.m_detail)
        market.body.addWidget(self.m_feeds)
        grid.addWidget(market, 2, 2)

        trading = Panel("TRADING")
        self.t_strat = Kv("STRATEGY")
        self.t_exec = Kv("EXECUTION")
        self.t_pos = Kv("POSITIONS")
        self.t_ready = Kv("READY")
        for w in (self.t_strat, self.t_exec, self.t_pos, self.t_ready):
            trading.body.addWidget(w)
        grid.addWidget(trading, 2, 3)

        # ── Row 3: Admin | Clients ─────────────────────────────────────────────
        admin = Panel("MSI ADMIN")
        self.a_conn = Kv("STATUS")
        self.a_ip = Kv("MSI IP")
        self.a_tr = Kv("TRANSPORT")
        self.a_hb = Kv("HEARTBEAT")
        for w in (self.a_conn, self.a_ip, self.a_tr, self.a_hb):
            admin.body.addWidget(w)
        grid.addWidget(admin, 3, 0, 1, 2)

        clients = Panel("CLIENTS")
        self.c_reg = Kv("REGISTERED")
        self.c_on = Kv("ONLINE")
        self.c_trade = Kv("TRADING")
        self.c_pause = Kv("PAUSED")
        for w in (self.c_reg, self.c_on, self.c_trade, self.c_pause):
            clients.body.addWidget(w)
        grid.addWidget(clients, 3, 2, 1, 2)

        # ── Row 4: Incidents | Events ──────────────────────────────────────────
        inc = Panel("INCIDENTS")
        self.incidents = VsTable(["EVENT"], ["msg"])
        inc.body.addWidget(self.incidents, 1)
        grid.addWidget(inc, 4, 0, 1, 2)

        ev = Panel("PRESENCE / CLIENT EVENTS")
        self.events = VsTable(["CLIENT", "STATUS"], ["name", "status"])
        ev.body.addWidget(self.events, 1)
        grid.addWidget(ev, 4, 2, 1, 2)

        scroll.setWidget(body_widget)
        layout.addWidget(scroll, 1)

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

        # ── Header connection label — never show LIVE READY from _connected alone ──
        live_on = snap.get("live_trading_enabled")
        operating_mode = (snap.get("operating_mode") or "").upper()
        if not connected:
            hdr_text = "● OFFLINE"
            hdr_off = "true"
        elif live_on:
            hdr_text = "● LIVE"
            hdr_off = "false"
        elif operating_mode in ("DEMO", "PAPER", "REPLAY"):
            hdr_text = f"● {operating_mode}"
            hdr_off = "true"
        else:
            hdr_text = "● CONNECTED"
            hdr_off = "false"

        self.live.setText(hdr_text)
        self.live.setProperty("off", hdr_off)
        self.live.style().unpolish(self.live)
        self.live.style().polish(self.live)

        self.clock.setText(f"UTC {snap.get('_ts') or '—'}")
        self.ver.setText(f"VERSION {nd(snap.get('server_version') or cell(snap, 'build', 'version'))}")
        self.build_lbl.setText(f"BUILD {nd(cell(snap, 'build', 'build_commit'))}")

        sys_snap = snap.get("system") or {}
        cpu = sys_snap.get("cpu_percent")
        ram = sys_snap.get("ram_percent")
        disk = sys_snap.get("disk_percent")

        # ── Subsystem KPIs ─────────────────────────────────────────────────────
        api_st = (cell(snap, "api", "status") or ("ONLINE" if connected else "OFFLINE")).upper()
        db_st = (cell(snap, "database", "status") or "OFFLINE").upper()
        bad_set = {"OFFLINE", "ERROR", "CRITICAL", "UNHEALTHY"}
        warn_set = {"DEGRADED", "WARNING", "STARTING"}
        if api_st in bad_set or db_st in bad_set:
            core_st = "ERROR"
        elif api_st in warn_set or db_st in warn_set:
            core_st = "DEGRADED"
        elif api_st in ("ONLINE", "HEALTHY", "OK") and db_st in ("ONLINE", "HEALTHY", "OK"):
            core_st = "ONLINE"
        else:
            core_st = api_st or "OFFLINE"
        self.kpi_core.set_value(core_st, tone=_tone(core_st))

        feeds = snap.get("feeds") or {}
        cap_feed = feeds.get("capital") or {}
        cap_st = cap_feed.get("status") if isinstance(cap_feed, dict) else str(cap_feed or "NO DATA")
        cap_st = cap_st or "NO DATA"
        self.kpi_capital.set_value(cap_st, tone=_tone(cap_st))

        feed_statuses = [
            v.get("status") or "" for k, v in feeds.items()
            if isinstance(v, dict) and k != "capital"
        ]
        active_f = sum(1 for s in feed_statuses if s.upper() in ("LIVE", "OK", "CONNECTED"))
        total_f = len(feed_statuses)
        if total_f == 0:
            feeds_label = "NO DATA"
            feeds_tone = "neutral"
        elif active_f == total_f:
            feeds_label = f"ALL LIVE ({active_f})"
            feeds_tone = "ok"
        elif active_f > 0:
            feeds_label = f"{active_f}/{total_f} LIVE"
            feeds_tone = "warn"
        else:
            feeds_label = f"0/{total_f} LIVE"
            feeds_tone = "bad"
        self.kpi_feeds.set_value(feeds_label, tone=feeds_tone)

        ohlc = snap.get("ohlc") or snap.get("canonical") or {}
        ohlc_st = ohlc.get("state") or ohlc.get("status") or "NO DATA"
        self.kpi_ohlc.set_value(ohlc_st, tone=_tone(ohlc_st))

        trading = snap.get("trading") or {}
        mp_ready = trading.get("readiness") == "READY" or trading.get("money_path_ready")
        mp_label = "READY" if mp_ready else "NOT READY"
        self.kpi_money.set_value(mp_label, tone=_tone(mp_label))

        live_label = "YES" if live_on else "NO"
        self.kpi_live_flag.set_value(
            live_label,
            tone="ok" if live_on else "bad",
        )

        strategy = snap.get("strategy") or {}
        robot_st = strategy.get("status") or "UNKNOWN"
        self.kpi_robot.set_value(robot_st, tone=_tone(robot_st))

        cl = snap.get("clients") or {}
        gw_online = cl.get("online")
        gw_total = cl.get("total")
        gw_label = (
            f"{gw_online}/{gw_total}" if gw_total is not None
            else (str(gw_online) if gw_online is not None else "NO DATA")
        )
        self.kpi_gateway.set_value(gw_label, tone="ok" if (gw_online or 0) > 0 else "neutral")

        # ── System panel ───────────────────────────────────────────────────────
        self.uptime.set_value(snap.get("uptime_human"), tone="ok" if connected else "bad")
        self.cpu.set_value(cpu if isinstance(cpu, (int, float)) else None)
        self.ram.set_value(ram if isinstance(ram, (int, float)) else None)
        self.ssd.set_value(disk if isinstance(disk, (int, float)) else None)
        self.net.setText(f"NETWORK  {nd(cell(snap, 'network', 'lan_ip') or cell(snap, 'network', 'status'))}")

        # ── DB / Cache ─────────────────────────────────────────────────────────
        self.db_status.set_value(cell(snap, "database", "status"), tone=tone_for(cell(snap, "database", "status")))
        self.db_detail.set_value(cell(snap, "database", "detail"))
        self.redis_status.set_value(cell(snap, "redis", "status"), tone=tone_for(cell(snap, "redis", "status")))
        self.redis_detail.set_value(cell(snap, "redis", "detail"))

        # ── Market ─────────────────────────────────────────────────────────────
        m = snap.get("market") or {}
        feed_txt = "  ".join(
            f"{k}:{v.get('status') if isinstance(v, dict) else v}" for k, v in feeds.items()
        ) or "NO DATA"
        self.m_status.set_value(m.get("status") or m.get("state"), tone=tone_for(m.get("status")))
        self.m_detail.set_value(m.get("detail"))
        self.m_feeds.set_value(feed_txt)

        # ── Trading ────────────────────────────────────────────────────────────
        st = snap.get("strategy") or {}
        ex = snap.get("execution") or {}
        self.t_strat.set_value(st.get("status"), tone=tone_for(st.get("status")))
        self.t_exec.set_value(ex.get("status"), tone=tone_for(ex.get("status")))
        self.t_pos.set_value(cl.get("online"))
        self.t_ready.set_value(trading.get("readiness"), tone=tone_for(trading.get("readiness")))

        # ── MSI Admin ──────────────────────────────────────────────────────────
        admin = snap.get("admin") or {}
        connected_admin = bool(admin.get("connected"))
        self.a_conn.set_value(
            "CONNECTED" if connected_admin else "DISCONNECTED",
            tone="ok" if connected_admin else "bad",
        )
        self.a_ip.set_value(admin.get("source_ip"))
        self.a_tr.set_value(admin.get("transport"))
        self.a_hb.set_value(admin.get("last_seen_human") or admin.get("last_seen"))

        # ── Clients ────────────────────────────────────────────────────────────
        devices = cl.get("devices") or []
        trading_n = sum(1 for d in devices if isinstance(d, dict) and str(d.get("status") or "").upper() in ("TRADING", "ONLINE", "CONNECTED"))
        paused_n = sum(1 for d in devices if isinstance(d, dict) and "PAUSE" in str(d.get("status") or "").upper())
        self.c_reg.set_value(cl.get("total"), tone="ok")
        self.c_on.set_value(cl.get("online"))
        self.c_trade.set_value(trading_n)
        self.c_pause.set_value(paused_n)

        # ── Incidents / Events ─────────────────────────────────────────────────
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

