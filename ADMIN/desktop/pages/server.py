from __future__ import annotations

from PySide6.QtWidgets import QGridLayout, QHBoxLayout

from pages.base import Page
from ui.format import cell, nd
from widgets.chrome import KpiCard, KvRow, Panel, ResourceGauges, VsTable


class ServerPage(Page):
    def __init__(self):
        super().__init__("SERVER")
        grid = QGridLayout()
        self.api = KpiCard("CONTROL API")
        self.db = KpiCard("POSTGRESQL")
        self.redis = KpiCard("REDIS")
        self.proc = KpiCard("PROCESS")
        for i, w in enumerate((self.api, self.db, self.redis, self.proc)):
            grid.addWidget(w, 0, i)
        self.root.addLayout(grid)

        row = QHBoxLayout()
        ident = Panel("IDENTITY")
        self.sid = KvRow("SERVER ID")
        self.host = KvRow("HOSTNAME")
        self.ver = KvRow("VERSION")
        self.build = KvRow("BUILD")
        self.uptime = KvRow("UPTIME")
        for w in (self.sid, self.host, self.ver, self.build, self.uptime):
            ident.body.addWidget(w)
        row.addWidget(ident, 1)

        res = Panel("SYSTEM")
        self.gauges = ResourceGauges()
        res.body.addWidget(self.gauges)
        row.addWidget(res, 1)
        self.root.addLayout(row)

        net = Panel("NETWORK")
        self.net_table = VsTable(["KEY", "VALUE"], ["k", "v"])
        net.body.addWidget(self.net_table, 1)
        self.root.addWidget(net, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        raw = s.get("raw") or {}

        def tone(status: str) -> str:
            st = (status or "").upper()
            if st in ("ONLINE", "HEALTHY", "OK"):
                return "ok"
            if st in ("DEGRADED", "WARNING", "STARTING"):
                return "warn"
            return "bad" if st else "neutral"

        api = raw.get("api") or {}
        db = raw.get("database") or {}
        redis = raw.get("redis") or {}
        proc = raw.get("server_process") or {}
        self.api.set_value(api.get("status"), sub=nd(api.get("detail")), tone=tone(api.get("status")))
        self.db.set_value(db.get("status"), sub=nd(db.get("detail")), tone=tone(db.get("status")))
        self.redis.set_value(redis.get("status"), sub=nd(redis.get("detail")), tone=tone(redis.get("status")))
        self.proc.set_value(proc.get("status"), sub=nd(proc.get("detail")), tone=tone(proc.get("status")))
        self.sid.set_value(s.get("server_id") or raw.get("server_id"))
        self.host.set_value(raw.get("hostname"))
        self.ver.set_value(s.get("server_version") or cell(raw, "build", "version"))
        self.build.set_value(cell(raw, "build", "build_commit"))
        self.uptime.set_value(s.get("uptime") or raw.get("uptime_human"))
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
