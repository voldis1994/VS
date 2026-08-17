from __future__ import annotations

from pages.base import Page
from widgets.chrome import VsTable


class AccountsPage(Page):
    def __init__(self):
        super().__init__("ACCOUNTS")
        self.set_note("Trading accounts bound to CLIENT logins. Provisioning is done on CLIENTS.")
        self.table = VsTable(
            ["LOGIN", "ACCOUNT", "ACCESS", "ROBOT", "MARKET", "LOT"],
            ["name", "account", "access", "robot", "market", "lot"],
        )
        self.root.addWidget(self.table, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        rows = []
        for c in s.get("clients") or []:
            if not isinstance(c, dict):
                continue
            rows.append(
                {
                    "name": c.get("name") or "—",
                    "account": c.get("account_id") or c.get("account_name") or "—",
                    "access": "ENABLED" if c.get("access_enabled") else "DISABLED",
                    "robot": c.get("robot_status") or "STOPPED",
                    "market": c.get("panel_epic") or "—",
                    "lot": c.get("panel_lot_size") if c.get("panel_lot_size") is not None else "—",
                }
            )
        self.table.set_rows(rows)
