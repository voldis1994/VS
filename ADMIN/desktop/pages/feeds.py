"""VS Admin — FEEDS page.

Two separate panels:
  1. CAPITAL EXECUTION  — Capital.com live quote (execution authority).
  2. PUBLIC REFERENCE FEEDS — independent public internet feeds (validation only).

Feed != Broker.
Public feeds are used to compare/validate Capital movement only.
Capital BID/ASK/MID is ALWAYS the execution authority — feeds never provide order price.
"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from pages.base import Page
from services.api import ApiError, ControlApi
from ui.format import nd
from widgets.chrome import KpiCard, KvRow, Panel, VsTable


def _tone(status: str | None) -> str:
    s = (status or "").upper()
    if s in ("LIVE", "OK", "CONNECTED", "PUBLIC_LIVE"):
        return "ok"
    if s in ("STALE", "SLOW", "WARN"):
        return "warn"
    if s in ("OFFLINE", "ERROR", "FAILED"):
        return "bad"
    return "neutral"


class FeedsPage(Page):
    def __init__(self, api: ControlApi):
        super().__init__("FEEDS")
        self.api = api
        self.set_note(
            "FEED ≠ BROKER. "
            "Capital.com is the execution authority. "
            "Public feeds provide independent price validation — they NEVER provide the order price."
        )

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        inner = QWidget()
        inner_lay = QVBoxLayout(inner)
        inner_lay.setContentsMargins(0, 0, 0, 0)
        inner_lay.setSpacing(16)

        # ── Capital Execution panel ──────────────────────────────────────────
        cap_panel = Panel("CAPITAL EXECUTION")
        cap_kpis = QHBoxLayout()
        self.cap_status = KpiCard("CONNECTION")
        self.cap_bid = KpiCard("BID")
        self.cap_ask = KpiCard("ASK")
        self.cap_mid = KpiCard("MID")
        self.cap_spread = KpiCard("SPREAD")
        self.cap_mkt = KpiCard("MARKET STATUS")
        for w in (self.cap_status, self.cap_bid, self.cap_ask, self.cap_mid, self.cap_spread, self.cap_mkt):
            cap_kpis.addWidget(w)
        cap_kpis.addStretch(1)
        self.cap_age = KvRow("QUOTE AGE")
        self.cap_epic = KvRow("EPIC")
        cap_panel.body.addLayout(cap_kpis)
        cap_panel.body.addWidget(self.cap_epic)
        cap_panel.body.addWidget(self.cap_age)
        inner_lay.addWidget(cap_panel)

        # ── Public Reference Feeds panel ─────────────────────────────────────
        pub_panel = Panel("PUBLIC REFERENCE FEEDS")
        pub_note = QLabel(
            "Reference feeds are read dynamically from i3. "
            "Capital.com is the execution authority — feeds are validation only."
        )
        pub_note.setObjectName("muted")
        pub_note.setWordWrap(True)
        pub_panel.body.addWidget(pub_note)

        btn_row = QHBoxLayout()
        self.btn_refresh = QPushButton("REFRESH")
        self.btn_refresh.setObjectName("Action")
        self.btn_refresh.clicked.connect(self._refresh_feeds)
        btn_row.addWidget(self.btn_refresh)
        btn_row.addStretch(1)
        pub_panel.body.addLayout(btn_row)

        self.pub_table = VsTable(
            ["PROVIDER", "TYPE", "MARKET", "STATUS", "VALUE", "LAST UPDATE", "AGE", "LATENCY", "TRUST", "CONTRIBUTING", "ERROR"],
            ["name", "kind", "epic", "status", "value", "timestamp", "age", "latency", "trust", "contributing", "error"],
        )
        pub_panel.body.addWidget(self.pub_table, 1)
        inner_lay.addWidget(pub_panel)

        # ── 10s OHLC Analysis panel ──────────────────────────────────────────
        ohlc_panel = Panel("10s CANONICAL OHLC ANALYSIS")
        ohlc_kpis = QHBoxLayout()
        self.ohlc_state = KpiCard("STATE")
        self.ohlc_open = KpiCard("O")
        self.ohlc_high = KpiCard("H")
        self.ohlc_low = KpiCard("L")
        self.ohlc_close = KpiCard("C")
        self.ohlc_conf = KpiCard("CONFIDENCE")
        for w in (self.ohlc_state, self.ohlc_open, self.ohlc_high, self.ohlc_low, self.ohlc_close, self.ohlc_conf):
            ohlc_kpis.addWidget(w)
        ohlc_kpis.addStretch(1)
        self.ohlc_sources = KvRow("SOURCE COUNT")
        self.ohlc_obs = KvRow("OBSERVATIONS")
        self.ohlc_agree = KvRow("AGREEMENT")
        self.ohlc_bar = KvRow("BAR START / END")
        ohlc_panel.body.addLayout(ohlc_kpis)
        for w in (self.ohlc_sources, self.ohlc_obs, self.ohlc_agree, self.ohlc_bar):
            ohlc_panel.body.addWidget(w)
        inner_lay.addWidget(ohlc_panel)

        inner_lay.addStretch(1)
        scroll.setWidget(inner)
        self.root.addWidget(scroll, 1)

    def _refresh_feeds(self) -> None:
        try:
            rows = self.api.get("/api/feeds") or []
        except ApiError as e:
            self.pub_table.set_rows([{"name": "ERROR", "kind": "", "epic": "", "status": str(e), "value": "", "timestamp": "", "age": "", "latency": "", "trust": "", "contributing": "", "error": str(e)}])
            return
        self._populate_feeds(rows if isinstance(rows, list) else [])

    def _populate_feeds(self, rows: list) -> None:
        table_rows = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            table_rows.append(
                {
                    "name": r.get("name") or r.get("sender_id") or "—",
                    "kind": r.get("kind") or r.get("type") or "—",
                    "epic": r.get("epic") or r.get("instrument") or "—",
                    "status": r.get("status") or r.get("market_status") or "—",
                    "value": nd(r.get("value") or r.get("mid") or r.get("price")),
                    "timestamp": (str(r.get("timestamp") or r.get("at") or "—"))[:19],
                    "age": str(r.get("age_ms") or r.get("age") or "—"),
                    "latency": str(r.get("latency_ms") or r.get("latency") or "—"),
                    "trust": r.get("trust") or "—",
                    "contributing": "YES" if r.get("contributing") else "NO",
                    "error": r.get("error") or "",
                }
            )
        self.pub_table.set_rows(table_rows)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        raw = s.get("raw") or {}

        # Capital execution data
        m = raw.get("market") or {}
        broker = s.get("broker") or {}
        state = broker.get("state") or m.get("status") or s.get("brokerState") or "NO DATA"
        self.cap_status.set_value(state, tone=_tone(state))
        self.cap_bid.set_value(s.get("marketBid") or m.get("bid"))
        self.cap_ask.set_value(s.get("marketAsk") or m.get("ask"))
        mid = s.get("marketMid") or m.get("mid")
        if mid is None:
            bid = s.get("marketBid") or m.get("bid")
            ask = s.get("marketAsk") or m.get("ask")
            if bid is not None and ask is not None:
                try:
                    mid = round((float(bid) + float(ask)) / 2, 5)
                except (TypeError, ValueError):
                    mid = None
        self.cap_mid.set_value(mid)
        self.cap_spread.set_value(s.get("marketSpread") or m.get("spread"))
        mkt_status = s.get("marketStatus") or m.get("marketStatus") or m.get("status")
        self.cap_mkt.set_value(mkt_status, tone=_tone(mkt_status))
        self.cap_epic.set_value(s.get("epic") or m.get("epic") or s.get("panelEpic"))
        self.cap_age.set_value(nd(s.get("quoteAge") or m.get("age_ms")))

        # Public feeds — from snapshot feeds dict or raw feed list
        feeds_dict = s.get("feeds") or {}
        if feeds_dict and isinstance(feeds_dict, dict):
            rows = []
            for feed_name, cell in feeds_dict.items():
                if isinstance(cell, dict):
                    rows.append(
                        {
                            "name": feed_name,
                            "kind": cell.get("kind") or "—",
                            "epic": cell.get("epic") or "—",
                            "status": cell.get("status") or "—",
                            "value": nd(cell.get("value") or cell.get("mid")),
                            "timestamp": (str(cell.get("timestamp") or cell.get("at") or "—"))[:19],
                            "age": str(cell.get("age_ms") or cell.get("age") or "—"),
                            "latency": str(cell.get("latency_ms") or "—"),
                            "trust": cell.get("trust") or "—",
                            "contributing": "YES" if cell.get("contributing") else "NO",
                            "error": cell.get("error") or "",
                        }
                    )
            if rows:
                self.pub_table.set_rows(rows)

        # 10s OHLC analysis
        ohlc = raw.get("ohlc") or raw.get("canonical") or s.get("ohlc") or {}
        ohlc_state = ohlc.get("state") or ohlc.get("status") or "NO DATA"
        self.ohlc_state.set_value(ohlc_state, tone=_tone(ohlc_state))
        self.ohlc_open.set_value(nd(ohlc.get("open") or ohlc.get("o")))
        self.ohlc_high.set_value(nd(ohlc.get("high") or ohlc.get("h")))
        self.ohlc_low.set_value(nd(ohlc.get("low") or ohlc.get("l")))
        self.ohlc_close.set_value(nd(ohlc.get("close") or ohlc.get("c") or ohlc.get("forming_close")))
        conf = ohlc.get("confidence") or ohlc.get("confidence_pct")
        self.ohlc_conf.set_value(nd(conf))
        self.ohlc_sources.set_value(nd(ohlc.get("source_count")))
        self.ohlc_obs.set_value(nd(ohlc.get("observation_count")))
        self.ohlc_agree.set_value(nd(ohlc.get("agreement")))
        bar_start = ohlc.get("bar_start") or ""
        bar_end = ohlc.get("bar_end") or ""
        self.ohlc_bar.set_value(f"{bar_start} → {bar_end}" if bar_start or bar_end else "—")
