from __future__ import annotations

from PySide6.QtWidgets import QGridLayout, QHBoxLayout, QScrollArea, QVBoxLayout, QWidget

from pages.base import Page
from ui.format import cell, nd
from widgets.chrome import KpiCard, KvRow, Panel, ResourceGauges, VsTable


def _tone(status: str | None) -> str:
    s = (status or "").upper()
    if s in ("ONLINE", "HEALTHY", "OK", "CONNECTED", "LIVE", "LIVE READY", "RUNNING"):
        return "ok"
    if s in ("DEGRADED", "WARNING", "WARN", "STARTING", "SEEDING", "DEMO", "PAPER"):
        return "warn"
    if s in ("OFFLINE", "ERROR", "CRITICAL", "FAILED", "STALE", "NO DATA", "NOT READY", "NOT_READY"):
        return "bad"
    return "neutral"


class ServerPage(Page):
    def __init__(self):
        super().__init__("SERVER")

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        inner = QWidget()
        inner_lay = QVBoxLayout(inner)
        inner_lay.setContentsMargins(0, 0, 0, 0)
        inner_lay.setSpacing(10)

        # ── Subsystem status grid (2 rows × 5 cols fits 1366×768) ──────────
        sub = Panel("SUBSYSTEMS")
        grid = QGridLayout()
        grid.setSpacing(8)
        self.kpi_core = KpiCard("CORE")
        self.kpi_capital = KpiCard("CAPITAL")
        self.kpi_feeds = KpiCard("FEEDS")
        self.kpi_ohlc = KpiCard("10s OHLC")
        self.kpi_money = KpiCard("MONEY PATH")
        self.kpi_live = KpiCard("LIVE ENABLED")
        self.kpi_robot = KpiCard("ROBOT")
        self.kpi_gateway = KpiCard("CLIENT GATEWAY")
        self.kpi_msi = KpiCard("MSI ADMIN")
        cards = [
            self.kpi_core, self.kpi_capital, self.kpi_feeds,
            self.kpi_ohlc, self.kpi_money,
            self.kpi_live, self.kpi_robot, self.kpi_gateway, self.kpi_msi,
        ]
        for i, w in enumerate(cards):
            grid.addWidget(w, i // 5, i % 5)
        sub.body.addLayout(grid)
        inner_lay.addWidget(sub)

        # ── Identity + System row ───────────────────────────────────────────
        row = QHBoxLayout()
        ident = Panel("IDENTITY")
        self.sid = KvRow("SERVER ID")
        self.host = KvRow("HOSTNAME")
        self.ver = KvRow("VERSION")
        self.build = KvRow("BUILD")
        self.uptime = KvRow("UPTIME")
        self.mode = KvRow("MODE")
        for w in (self.sid, self.host, self.ver, self.build, self.uptime, self.mode):
            ident.body.addWidget(w)
        row.addWidget(ident, 1)

        res = Panel("SYSTEM")
        self.gauges = ResourceGauges()
        res.body.addWidget(self.gauges)
        row.addWidget(res, 1)
        inner_lay.addLayout(row)

        # ── Network ─────────────────────────────────────────────────────────
        net = Panel("NETWORK")
        self.net_table = VsTable(["KEY", "VALUE"], ["k", "v"])
        net.body.addWidget(self.net_table, 1)
        inner_lay.addWidget(net)

        inner_lay.addStretch(1)
        scroll.setWidget(inner)
        self.root.addWidget(scroll, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        raw = s.get("raw") or {}

        api = raw.get("api") or {}
        db = raw.get("database") or {}

        # CORE: worst of api + database
        api_st = (api.get("status") or "OFFLINE").upper()
        db_st = (db.get("status") or "OFFLINE").upper()
        bad = {"OFFLINE", "ERROR", "CRITICAL", "UNHEALTHY"}
        warn_set = {"DEGRADED", "WARNING", "STARTING"}
        if api_st in bad or db_st in bad:
            core_st = "ERROR"
        elif api_st in warn_set or db_st in warn_set:
            core_st = "DEGRADED"
        elif api_st in ("ONLINE", "HEALTHY", "OK") and db_st in ("ONLINE", "HEALTHY", "OK"):
            core_st = "ONLINE"
        else:
            core_st = api_st or db_st or "UNKNOWN"
        self.kpi_core.set_value(core_st, sub=nd(api.get("detail")), tone=_tone(core_st))

        # Capital
        feeds = raw.get("feeds") or {}
        cap = feeds.get("capital") or {}
        cap_st = cap.get("status") or "NO DATA"
        self.kpi_capital.set_value(cap_st, sub=nd(cap.get("detail")), tone=_tone(cap_st))

        # Feeds — count active public feeds from feeds dict; exclude capital
        feed_statuses = [
            v.get("status") or "" for k, v in feeds.items()
            if isinstance(v, dict) and k != "capital"
        ]
        if not feed_statuses:
            snap_feeds = s.get("feeds") or {}
            feed_statuses = [
                v.get("status") or "" for v in snap_feeds.values()
                if isinstance(v, dict)
            ]
        active_feeds = sum(1 for st in feed_statuses if st.upper() in ("LIVE", "OK", "CONNECTED"))
        total_feeds = len(feed_statuses)
        if total_feeds == 0:
            feeds_label = "NO DATA"
            feeds_tone = "neutral"
        elif active_feeds == total_feeds:
            feeds_label = f"ALL LIVE ({active_feeds})"
            feeds_tone = "ok"
        elif active_feeds > 0:
            feeds_label = f"{active_feeds}/{total_feeds} LIVE"
            feeds_tone = "warn"
        else:
            feeds_label = f"0/{total_feeds} LIVE"
            feeds_tone = "bad"
        self.kpi_feeds.set_value(feeds_label, tone=feeds_tone)

        # 10s OHLC — use authoritative server state only
        ohlc = raw.get("ohlc") or raw.get("canonical") or s.get("ohlc") or {}
        ohlc_st = ohlc.get("state") or ohlc.get("status") or "NO DATA"
        self.kpi_ohlc.set_value(ohlc_st, tone=_tone(ohlc_st))

        # Money Path
        mp_ready = s.get("money_path_ready") or s.get("moneyPathReady")
        trading = raw.get("trading") or {}
        if mp_ready is None:
            mp_ready = trading.get("readiness") == "READY" or trading.get("enabled")
        mp_label = "READY" if mp_ready else "NOT READY"
        self.kpi_money.set_value(mp_label, sub=nd(trading.get("detail")), tone=_tone(mp_label))

        # LIVE enabled
        live_on = raw.get("live_trading_enabled")
        if live_on is None:
            live_on = trading.get("enabled") or trading.get("mode") == "LIVE"
        live_label = "YES" if live_on else "NO"
        live_mode = raw.get("operating_mode") or trading.get("mode") or ""
        self.kpi_live.set_value(
            live_label,
            sub=live_mode or None,
            tone="ok" if live_on else "bad",
        )

        # Robot
        strategy = raw.get("strategy") or {}
        robot_st = strategy.get("status") or "UNKNOWN"
        self.kpi_robot.set_value(robot_st, sub=nd(strategy.get("detail")), tone=_tone(robot_st))

        # Client Gateway
        clients_snap = raw.get("clients") or {}
        online = clients_snap.get("online")
        total = clients_snap.get("total")
        if online is None:
            online = s.get("clientsOnline")
            total = s.get("clientsRegistered")
        gw_label = f"{online}/{total}" if total is not None else (str(online) if online is not None else "NO DATA")
        gw_tone = "ok" if (online or 0) > 0 else "neutral"
        self.kpi_gateway.set_value(gw_label, sub="online/registered", tone=gw_tone)

        # MSI Admin (this process)
        admin = raw.get("admin") or {}
        msi_st = admin.get("status") or ("CONNECTED" if admin.get("connected") else "OFFLINE")
        self.kpi_msi.set_value(msi_st, sub=nd(admin.get("device_name")), tone=_tone(msi_st))

        # Identity
        self.sid.set_value(s.get("server_id") or raw.get("server_id"))
        self.host.set_value(raw.get("hostname"))
        self.ver.set_value(s.get("server_version") or cell(raw, "build", "version"))
        self.build.set_value(cell(raw, "build", "build_commit"))
        self.uptime.set_value(s.get("uptime") or raw.get("uptime_human"))
        self.mode.set_value(raw.get("operating_mode") or live_mode)

        self.gauges.apply(s)

        net = raw.get("network") or {}
        wg = raw.get("wireguard") or {}
        self.net_table.set_rows(
            [
                {"k": "LAN IP", "v": net.get("lan_ip") or s.get("network")},
                {"k": "NETWORK", "v": net.get("status")},
                {"k": "INTERNET", "v": net.get("internet")},
                {"k": "WIREGUARD", "v": wg.get("status")},
                {"k": "WG PEERS", "v": wg.get("peers")},
            ]
        )
