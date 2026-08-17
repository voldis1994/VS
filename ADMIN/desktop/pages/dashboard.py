from __future__ import annotations

from PySide6.QtWidgets import QGridLayout, QHBoxLayout, QLabel, QScrollArea, QVBoxLayout, QWidget

from pages.base import Page
from ui.format import nd
from widgets.chrome import FeedPills, KpiCard, Panel, ResourceGauges, VsTable


class DashboardPage(Page):
    def __init__(self):
        super().__init__("DASHBOARD")
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        inner = QWidget()
        body = QVBoxLayout(inner)
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(12)

        self.cards: dict[str, KpiCard] = {}
        grid = QGridLayout()
        grid.setSpacing(10)
        specs = [
            ("health", "SERVER HEALTH"),
            ("uptime", "UPTIME"),
            ("clients", "CLIENTS"),
            ("accounts", "ACCOUNTS"),
            ("positions", "OPEN POSITIONS"),
            ("pnl", "TODAY P/L"),
        ]
        for i, (key, title) in enumerate(specs):
            card = KpiCard(title)
            self.cards[key] = card
            grid.addWidget(card, i // 3, i % 3)
        body.addLayout(grid)

        mid = QHBoxLayout()
        market = Panel("MARKET OVERVIEW")
        self.market_status = QLabel("NO DATA")
        self.market_status.setObjectName("CardValue")
        self.market_detail = QLabel("NO DATA")
        self.market_detail.setObjectName("muted")
        self.market_detail.setWordWrap(True)
        self.quote = QLabel("PRICE  NO DATA    BID  NO DATA    ASK  NO DATA    SPREAD  NO DATA")
        market.body.addWidget(self.market_status)
        market.body.addWidget(self.market_detail)
        market.body.addWidget(self.quote)
        chart = QLabel("NO CHART — waiting for live 10s OHLC from VS CORE")
        chart.setObjectName("muted")
        chart.setMinimumHeight(72)
        market.body.addWidget(chart)
        mid.addWidget(market, 2)

        res = Panel("SYSTEM RESOURCES")
        self.gauges = ResourceGauges()
        res.body.addWidget(self.gauges)
        mid.addWidget(res, 1)
        body.addLayout(mid)

        feeds = Panel("FEED HEALTH")
        self.feeds = FeedPills()
        feeds.body.addWidget(self.feeds)
        body.addWidget(feeds)

        tables = QHBoxLayout()
        clients = Panel("CLIENT STATUS")
        self.client_table = VsTable(
            ["CLIENT", "STATUS", "TRANSPORT", "LAST SEEN"],
            ["name", "status", "transport", "seen"],
        )
        clients.body.addWidget(self.client_table, 1)
        orders = Panel("RECENT ORDERS")
        self.order_table = VsTable(
            ["ORDER", "SIDE", "STATUS", "SIZE"],
            ["id", "side", "status", "size"],
        )
        orders.body.addWidget(self.order_table, 1)
        tables.addWidget(clients, 1)
        tables.addWidget(orders, 1)
        body.addLayout(tables, 1)

        bottom = QHBoxLayout()
        inc = Panel("INCIDENTS")
        self.incidents = VsTable(["SEV", "CODE", "MESSAGE"], ["sev", "code", "message"])
        inc.body.addWidget(self.incidents, 1)
        ev = Panel("RECENT EVENTS")
        self.events = VsTable(["TYPE", "MESSAGE"], ["type", "message"])
        ev.body.addWidget(self.events, 1)
        bottom.addWidget(inc, 1)
        bottom.addWidget(ev, 1)
        body.addLayout(bottom, 1)

        scroll.setWidget(inner)
        self.root.addWidget(scroll, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        health = s.get("health")
        tone = "ok" if health == "HEALTHY" else "warn" if health == "DEGRADED" else "bad"
        self.cards["health"].set_value(health, sub=nd(s.get("server_id")), tone=tone)
        self.cards["uptime"].set_value(s.get("uptime"))
        self.cards["clients"].set_value(
            f"{s.get('clientsOnline') or 0} / {s.get('clientsRegistered') or 0}",
            sub="online / registered",
        )
        n_acc = len(s.get("clients") or [])
        self.cards["accounts"].set_value(n_acc if n_acc else None, sub="provisioned logins")
        self.cards["positions"].set_value(s.get("openPositions"))
        self.cards["pnl"].set_value(s.get("totalPnlToday"))

        self.market_status.setText(nd(s.get("marketStatus")))
        self.market_detail.setText(nd(s.get("marketDetail")))
        self.quote.setText(
            f"PRICE  {nd(s.get('marketBid') if s.get('marketBid') is not None else s.get('marketAsk'))}"
            f"    BID  {nd(s.get('marketBid'))}"
            f"    ASK  {nd(s.get('marketAsk'))}"
            f"    SPREAD  {nd(s.get('marketSpread'))}"
        )
        self.gauges.apply(s)
        self.feeds.set_feeds(s.get("feeds") or {})

        rows = []
        for c in s.get("presenceClients") or []:
            if not isinstance(c, dict):
                continue
            rows.append(
                {
                    "name": c.get("display_name") or c.get("device_id") or "—",
                    "status": c.get("status") or "—",
                    "transport": "LAN",
                    "seen": "heartbeat" if c.get("app_connected") else "NO DATA",
                }
            )
        for d in s.get("devices") or []:
            if not isinstance(d, dict):
                continue
            rows.append(
                {
                    "name": d.get("device_id") or "—",
                    "status": d.get("connection_state") or d.get("status") or "—",
                    "transport": d.get("transport") or "—",
                    "seen": d.get("last_seen_human") or "NO DATA",
                }
            )
        self.client_table.set_rows(rows)
        orders = []
        for o in (s.get("orders") or [])[:20]:
            if not isinstance(o, dict):
                continue
            orders.append(
                {
                    "id": o.get("id") or o.get("order_id") or "—",
                    "side": o.get("side") or "—",
                    "status": o.get("status") or "—",
                    "size": o.get("size") or o.get("lot") or "—",
                }
            )
        self.order_table.set_rows(orders)
        incs = []
        for i in s.get("incidents") or []:
            if isinstance(i, dict):
                incs.append(
                    {
                        "sev": i.get("severity") or "—",
                        "code": i.get("code") or "—",
                        "message": i.get("message") or i.get("detail") or "—",
                    }
                )
        self.incidents.set_rows(incs)
        events = []
        for ev in s.get("events") or []:
            if isinstance(ev, dict):
                events.append({"type": ev.get("type") or "event", "message": ev.get("message") or "—"})
            else:
                events.append({"type": "event", "message": str(ev)})
        self.events.set_rows(events)
