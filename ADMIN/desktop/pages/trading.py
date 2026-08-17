from __future__ import annotations

from PySide6.QtWidgets import QGridLayout

from pages.base import Page
from ui.format import cell, nd
from widgets.chrome import KpiCard, KvRow, Panel


def _tone(v) -> str:
    s = str(v or "").upper()
    if s in ("READY", "TRUE", "ONLINE", "HEALTHY", "OK", "ENABLED"):
        return "ok"
    if s in ("FALSE", "NOT_READY", "BLOCKED", "ERROR", "FAILED", "OFFLINE"):
        return "bad"
    return "warn" if s else "neutral"


class TradingPage(Page):
    def __init__(self):
        super().__init__("TRADING")
        grid = QGridLayout()
        self.ready = KpiCard("TRADING READY")
        self.broker = KpiCard("BROKER")
        self.mode = KpiCard("MODE")
        self.live = KpiCard("LIVE TRADING")
        for i, w in enumerate((self.ready, self.broker, self.mode, self.live)):
            grid.addWidget(w, 0, i)
        self.root.addLayout(grid)
        gates = Panel("READINESS GATES")
        self.rows = {
            "process": KvRow("PROCESS READY"),
            "system": KvRow("SYSTEM READY"),
            "market": KvRow("MARKET"),
            "risk": KvRow("RISK"),
            "execution": KvRow("EXECUTION"),
            "blockers": KvRow("BLOCKERS"),
        }
        for w in self.rows.values():
            gates.body.addWidget(w)
        self.root.addWidget(gates)
        self.root.addStretch(1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        raw = s.get("raw") or {}
        sup = s.get("supervisor") or {}
        br = s.get("broker") or {}
        tr = raw.get("trading") or {}
        self.ready.set_value(
            tr.get("readiness") or sup.get("trading_ready"),
            sub=nd(tr.get("detail")),
            tone=_tone(tr.get("readiness") or sup.get("trading_ready")),
        )
        self.broker.set_value(br.get("state"), tone=_tone(br.get("state")))
        self.mode.set_value(tr.get("mode") or raw.get("operating_mode"))
        self.live.set_value(raw.get("live_trading_enabled"), tone=_tone(raw.get("live_trading_enabled")))
        self.rows["process"].set_value(sup.get("process_ready"), tone=_tone(sup.get("process_ready")))
        self.rows["system"].set_value(sup.get("system_ready"), tone=_tone(sup.get("system_ready")))
        self.rows["market"].set_value(s.get("marketStatus"))
        self.rows["risk"].set_value(cell(raw, "risk", "status"))
        self.rows["execution"].set_value(cell(raw, "execution", "status"))
        self.rows["blockers"].set_value(sup.get("trading_blockers") or "NONE")


class StrategiesPage(Page):
    def __init__(self):
        super().__init__("STRATEGIES")
        self.card = KpiCard("STRATEGY")
        self.root.addWidget(self.card)
        detail = Panel("DETAIL")
        self.detail = KvRow("STATUS")
        self.note_row = KvRow("DETAIL")
        detail.body.addWidget(self.detail)
        detail.body.addWidget(self.note_row)
        self.root.addWidget(detail)
        self.root.addStretch(1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        st = (s.get("raw") or {}).get("strategy") or {}
        self.card.set_value(st.get("status"), sub=nd(st.get("detail")), tone=_tone(st.get("status")))
        self.detail.set_value(st.get("status"))
        self.note_row.set_value(st.get("detail"))


class ExecutionPage(Page):
    def __init__(self):
        super().__init__("EXECUTION")
        self.card = KpiCard("EXECUTION")
        self.recon = KpiCard("RECONCILIATION")
        row = QGridLayout()
        row.addWidget(self.card, 0, 0)
        row.addWidget(self.recon, 0, 1)
        self.root.addLayout(row)
        p = Panel("DETAIL")
        self.d1 = KvRow("EXECUTION")
        self.d2 = KvRow("RECONCILIATION")
        p.body.addWidget(self.d1)
        p.body.addWidget(self.d2)
        self.root.addWidget(p)
        self.root.addStretch(1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        raw = s.get("raw") or {}
        ex = raw.get("execution") or {}
        rec = raw.get("reconciliation") or {}
        self.card.set_value(ex.get("status"), sub=nd(ex.get("detail")), tone=_tone(ex.get("status")))
        self.recon.set_value(rec.get("status"), sub=nd(rec.get("detail")), tone=_tone(rec.get("status")))
        self.d1.set_value(ex.get("detail"))
        self.d2.set_value(rec.get("detail"))
