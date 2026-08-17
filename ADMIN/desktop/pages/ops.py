from __future__ import annotations

from pages.base import Page
from widgets.chrome import VsTable


class PositionsPage(Page):
    def __init__(self):
        super().__init__("POSITIONS")
        self.table = VsTable(
            ["SYMBOL", "SIDE", "LOT", "ENTRY", "P/L", "STATUS"],
            ["symbol", "side", "lot", "entry", "pnl", "status"],
        )
        self.root.addWidget(self.table, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        rows = []
        for p in s.get("positions") or []:
            if not isinstance(p, dict):
                continue
            rows.append(
                {
                    "symbol": p.get("symbol") or p.get("market") or p.get("epic"),
                    "side": p.get("side") or p.get("direction"),
                    "lot": p.get("size") or p.get("lot") or p.get("quantity"),
                    "entry": p.get("entry_price") or p.get("open_level"),
                    "pnl": p.get("pnl") if p.get("pnl") is not None else p.get("unrealized_pnl"),
                    "status": p.get("status") or "OPEN",
                }
            )
        self.table.set_rows(rows)


class OrdersPage(Page):
    def __init__(self):
        super().__init__("ORDERS")
        self.table = VsTable(
            ["ID", "SYMBOL", "SIDE", "STATUS", "SIZE"],
            ["id", "symbol", "side", "status", "size"],
        )
        self.root.addWidget(self.table, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        rows = []
        for o in s.get("orders") or []:
            if not isinstance(o, dict):
                continue
            rows.append(
                {
                    "id": o.get("id") or o.get("order_id"),
                    "symbol": o.get("symbol") or o.get("epic") or o.get("market"),
                    "side": o.get("side"),
                    "status": o.get("status"),
                    "size": o.get("size") or o.get("lot"),
                }
            )
        self.table.set_rows(rows)


class TradesPage(Page):
    def __init__(self):
        super().__init__("TRADES")
        self.table = VsTable(
            ["ID", "SYMBOL", "SIDE", "LOT", "P/L", "REASON"],
            ["id", "symbol", "side", "lot", "pnl", "reason"],
        )
        self.root.addWidget(self.table, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        rows = []
        for t in s.get("trades") or []:
            if not isinstance(t, dict):
                continue
            rows.append(
                {
                    "id": t.get("id") or t.get("trade_id"),
                    "symbol": t.get("symbol") or t.get("epic"),
                    "side": t.get("side"),
                    "lot": t.get("lot") or t.get("size") or t.get("quantity"),
                    "pnl": t.get("pnl"),
                    "reason": t.get("exit_reason") or t.get("reason"),
                }
            )
        self.table.set_rows(rows)


class IncidentsPage(Page):
    def __init__(self):
        super().__init__("INCIDENTS")
        self.table = VsTable(
            ["SEV", "CODE", "MESSAGE"],
            ["sev", "code", "message"],
        )
        self.root.addWidget(self.table, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        rows = []
        for i in s.get("incidents") or []:
            if isinstance(i, dict):
                rows.append(
                    {
                        "sev": i.get("severity"),
                        "code": i.get("code"),
                        "message": i.get("message") or i.get("detail"),
                    }
                )
            else:
                rows.append({"sev": "—", "code": "—", "message": str(i)})
        self.table.set_rows(rows)
