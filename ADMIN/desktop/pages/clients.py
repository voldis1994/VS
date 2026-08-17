from __future__ import annotations

from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from models.table_model import DictTableModel
from services.api import ApiError, ControlApi


class ClientsPage(QWidget):
    def __init__(self, api: ControlApi):
        super().__init__()
        self.api = api
        root = QVBoxLayout(self)
        title = QLabel("CLIENTS")
        title.setObjectName("Section")
        root.addWidget(title)
        row = QHBoxLayout()
        self.name = QLineEdit()
        self.name.setPlaceholderText("login name")
        create = QPushButton("CREATE WEB LOGIN")
        create.setObjectName("Primary")
        create.clicked.connect(self._create)
        row.addWidget(self.name)
        row.addWidget(create)
        root.addLayout(row)
        self.hint = QLabel(
            "Create a client HTTPS login. Password is shown once. Public URL comes from /etc/vs/client-url."
        )
        self.hint.setWordWrap(True)
        self.hint.setObjectName("muted")
        root.addWidget(self.hint)
        self.model = DictTableModel(
            ["LOGIN", "ACCESS", "ROBOT", "MARKET", "LOT"],
            ["name", "access", "robot", "market", "lot"],
        )
        self.table = QTableView()
        self.table.setModel(self.model)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.verticalHeader().setVisible(False)
        root.addWidget(self.table, 1)

    def apply(self, s: dict) -> None:
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
        self.model.set_rows(rows)

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
