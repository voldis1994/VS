from __future__ import annotations

from PySide6.QtWidgets import QHBoxLayout, QLabel

from pages.base import Page
from ui.format import nd
from widgets.chrome import FeedPills, KpiCard, Panel, VsTable


class MarketPage(Page):
    def __init__(self):
        super().__init__("MARKET")
        row = QHBoxLayout()
        self.status = KpiCard("MARKET STATE")
        self.bid = KpiCard("BID")
        self.ask = KpiCard("ASK")
        self.spread = KpiCard("SPREAD")
        for w in (self.status, self.bid, self.ask, self.spread):
            row.addWidget(w)
        self.root.addLayout(row)
        feeds = Panel("FEEDS")
        self.feeds = FeedPills()
        feeds.body.addWidget(self.feeds)
        self.root.addWidget(feeds)
        detail = Panel("10s OHLC / TICKS")
        self.detail = QLabel("NO DATA")
        self.detail.setWordWrap(True)
        detail.body.addWidget(self.detail)
        self.table = VsTable(["FEED", "STATUS", "DETAIL"], ["name", "status", "detail"])
        detail.body.addWidget(self.table, 1)
        self.root.addWidget(detail, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        raw = s.get("raw") or {}
        m = raw.get("market") or {}
        self.status.set_value(s.get("marketStatus") or m.get("status"), sub=nd(m.get("state")))
        self.bid.set_value(s.get("marketBid"))
        self.ask.set_value(s.get("marketAsk"))
        self.spread.set_value(s.get("marketSpread"))
        feeds = s.get("feeds") or {}
        self.feeds.set_feeds(feeds)
        self.detail.setText(nd(s.get("marketDetail") or m.get("detail")))
        rows = []
        for name, cell in feeds.items():
            if isinstance(cell, dict):
                rows.append({"name": name, "status": cell.get("status"), "detail": cell.get("detail")})
            else:
                rows.append({"name": name, "status": cell, "detail": ""})
        self.table.set_rows(rows)
