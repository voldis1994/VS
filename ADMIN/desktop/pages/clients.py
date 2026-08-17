from __future__ import annotations

from PySide6.QtWidgets import QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton

from pages.base import Page
from services.api import ApiError, ControlApi
from widgets.chrome import VsTable


class ClientsPage(Page):
    def __init__(self, api: ControlApi):
        super().__init__("CLIENTS")
        self.api = api
        row = QHBoxLayout()
        self.name = QLineEdit()
        self.name.setPlaceholderText("login name")
        create = QPushButton("CREATE WEB LOGIN")
        create.setObjectName("Primary")
        create.clicked.connect(self._create)
        row.addWidget(self.name, 1)
        row.addWidget(create)
        self.root.addLayout(row)
        hint = QLabel(
            "Creates a CLIENT HTTPS login. Password is shown once. Public URL is /etc/vs/client-url on :443. "
            "This panel contains no trading logic."
        )
        hint.setWordWrap(True)
        hint.setObjectName("muted")
        self.root.addWidget(hint)
        self.table = VsTable(
            ["LOGIN", "ACCESS", "ROBOT", "MARKET", "LOT"],
            ["name", "access", "robot", "market", "lot"],
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
                    "access": "ENABLED" if c.get("access_enabled") else "DISABLED",
                    "robot": c.get("robot_status") or "STOPPED",
                    "market": c.get("panel_epic") or "—",
                    "lot": c.get("panel_lot_size") if c.get("panel_lot_size") is not None else "—",
                }
            )
        self.table.set_rows(rows)

    def _create(self) -> None:
        login = self.name.text().strip()
        if not login:
            QMessageBox.warning(self, "VS Admin", "Enter client login name")
            return
        try:
            res = self.api.post("/api/clients/provision-web", {"name": login}) or {}
        except ApiError as e:
            QMessageBox.critical(self, "VS Admin", str(e))
            return
        url = res.get("panel_url") or res.get("panel_url_public") or "NOT SET — /etc/vs/client-url"
        QMessageBox.information(
            self,
            "CLIENT ACCESS — save now",
            f"PUBLIC WEB URL:\n{url}\n\nLOGIN: {res.get('login')}\nPASSWORD: {res.get('password')}\n\n"
            f"{res.get('message') or ''}",
        )
        self.name.clear()
