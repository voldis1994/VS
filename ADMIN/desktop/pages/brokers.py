"""Brokers page — save Capital.com credentials and TEST the session."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
)

from pages.base import Page
from services.api import ApiError, ControlApi
from widgets.chrome import VsTable


class BrokersPage(Page):
    def __init__(self, api: ControlApi):
        super().__init__("BROKERS")
        self.api = api
        self._clients: list[dict] = []
        self._rows: list[dict] = []
        self._client_fp: tuple | None = None
        self._broker_fp: tuple | None = None
        self.set_note(
            "Capital.com Live / Demo — execution venue. Save identifier + API key + API password, then TEST. "
            "Catalog pull is on Accounts."
        )

        form = QHBoxLayout()
        self.client = QComboBox()
        self.client.setMinimumWidth(180)
        self.broker = QComboBox()
        self.broker.addItems(["capital_com", "paper"])
        self.env = QComboBox()
        self.env.addItems(["demo", "live"])
        self.identifier = QLineEdit()
        self.identifier.setPlaceholderText("login email")
        self.api_key = QLineEdit()
        self.api_key.setPlaceholderText("API key (not email)")
        self.api_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.password = QLineEdit()
        self.password.setPlaceholderText("API password")
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        save = QPushButton("SAVE")
        save.setObjectName("Primary")
        save.clicked.connect(self._save)
        form.addWidget(self.client, 1)
        form.addWidget(self.broker)
        form.addWidget(self.env)
        form.addWidget(self.identifier, 1)
        form.addWidget(self.api_key, 1)
        form.addWidget(self.password, 1)
        form.addWidget(save)
        self.root.addLayout(form)

        actions = QHBoxLayout()
        test = QPushButton("TEST SELECTED")
        test.clicked.connect(self._test)
        delete = QPushButton("DELETE SELECTED")
        delete.clicked.connect(self._delete)
        self.lbl = QLabel("")
        self.lbl.setObjectName("muted")
        self.lbl.setWordWrap(True)
        actions.addWidget(test)
        actions.addWidget(delete)
        actions.addWidget(self.lbl, 1)
        self.root.addLayout(actions)

        self.table = VsTable(
            ["ID", "CLIENT", "BROKER", "ENV", "ENABLED"],
            ["id", "client", "broker", "env", "enabled"],
        )
        self.root.addWidget(self.table, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        self._clients = [c for c in (s.get("clients") or []) if isinstance(c, dict)]
        client_fp = tuple((c.get("id"), c.get("name")) for c in self._clients)
        if client_fp != self._client_fp:
            self._client_fp = client_fp
            current = self.client.currentData()
            self.client.blockSignals(True)
            self.client.clear()
            if not self._clients:
                self.client.addItem("Will create Default Client", None)
            for c in self._clients:
                cid = c.get("id")
                name = c.get("name") or f"#{cid}"
                self.client.addItem(f"{name} (#{cid})", cid)
            if current is not None:
                idx = self.client.findData(current)
                if idx >= 0:
                    self.client.setCurrentIndex(idx)
            self.client.blockSignals(False)

        self._rows = [b for b in (s.get("brokers") or []) if isinstance(b, dict)]
        broker_fp = tuple(
            (
                b.get("id"),
                b.get("client_name") or b.get("client_id"),
                b.get("broker_name"),
                b.get("environment"),
                bool(b.get("enabled")),
            )
            for b in self._rows
        )
        if broker_fp == self._broker_fp:
            return
        self._broker_fp = broker_fp
        selected = self._selected_id()
        self.table.set_rows(
            [
                {
                    "id": b.get("id"),
                    "client": b.get("client_name") or b.get("client_id") or "—",
                    "broker": b.get("broker_name") or "—",
                    "env": b.get("environment") or "—",
                    "enabled": "YES" if b.get("enabled") else "NO",
                }
                for b in self._rows
            ]
        )
        if selected is not None:
            for i, b in enumerate(self._rows):
                try:
                    if int(b.get("id")) == selected:
                        self.table.selectRow(i)
                        break
                except (TypeError, ValueError):
                    continue

    def _selected_id(self) -> int | None:
        indexes = self.table.selectionModel().selectedRows()
        if not indexes:
            return None
        row = indexes[0].row()
        if row < 0 or row >= len(self._rows):
            return None
        raw = self._rows[row].get("id")
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None

    def _save(self) -> None:
        ident = self.identifier.text().strip()
        key = self.api_key.text().strip()
        password = self.password.text().strip()
        broker = self.broker.currentText()
        if not ident:
            QMessageBox.warning(self, "VS Admin", "Identifier (login email) is required")
            return
        if broker == "capital_com":
            if not key or not password:
                QMessageBox.warning(
                    self, "VS Admin", "Capital.com needs API Key and API Password from Settings → API"
                )
                return
            if "@" in key:
                QMessageBox.warning(
                    self, "VS Admin", "API Key looks like an email — put email in Identifier"
                )
                return
        body: dict = {
            "broker_name": broker,
            "environment": self.env.currentText(),
            "identifier": ident,
            "api_key": key,
            "password": password,
        }
        cid = self.client.currentData()
        if cid is not None:
            body["client_id"] = int(cid)
        try:
            self.api.post("/api/brokers", body)
            self.api_key.clear()
            self.password.clear()
            self.lbl.setText("Saved. TEST the row, then PULL catalog on Accounts.")
        except ApiError as e:
            QMessageBox.critical(self, "VS Admin", str(e))

    def _test(self) -> None:
        bid = self._selected_id()
        if bid is None:
            QMessageBox.warning(self, "VS Admin", "Select a broker row")
            return
        self.lbl.setText("Testing…")
        try:
            res = self.api.request("POST", f"/api/brokers/{bid}/test", {}, timeout=30) or {}
        except ApiError as e:
            self.lbl.setText(str(e))
            QMessageBox.critical(self, "VS Admin", str(e))
            return
        if res.get("success"):
            extra = ""
            accounts = res.get("capital_accounts") or []
            if accounts:
                extra = " · " + ", ".join(
                    str(a.get("accountName") or a.get("accountId")) for a in accounts[:4]
                )
            self.lbl.setText(str(res.get("message") or "Connection OK") + extra)
        else:
            msg = str(res.get("error") or "Connection test failed")
            self.lbl.setText(msg)
            QMessageBox.critical(self, "VS Admin", msg)

    def _delete(self) -> None:
        bid = self._selected_id()
        if bid is None:
            QMessageBox.warning(self, "VS Admin", "Select a broker row")
            return
        if (
            QMessageBox.question(
                self,
                "VS Admin",
                f"DELETE broker #{bid}? Removes credentials and linked account settings.",
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        try:
            self.api.request("DELETE", f"/api/brokers/{bid}?hard=true")
            self.lbl.setText(f"Deleted broker #{bid}")
        except ApiError as e:
            QMessageBox.critical(self, "VS Admin", str(e))
