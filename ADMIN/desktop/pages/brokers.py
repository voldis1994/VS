"""VS Admin — BROKERS page (Capital.com LIVE configuration).

MSI sends credentials only to authenticated i3 Control API.
i3 stores secrets encrypted in PostgreSQL.
Plaintext API key/password is NEVER stored locally anywhere in MSI.
"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from pages.base import Page
from services.api import ApiError, ControlApi
from widgets.chrome import KvRow, Panel, VsTable


class BrokerForm(QWidget):
    """Credential entry form for one Capital.com LIVE broker connection."""

    def __init__(self, api: ControlApi):
        super().__init__()
        self.api = api
        self._broker_id: int | None = None

        box = QGroupBox("CAPITAL.COM LIVE")
        box.setObjectName("Card")
        form_lay = QFormLayout(box)
        form_lay.setContentsMargins(14, 12, 14, 12)
        form_lay.setSpacing(10)

        self.identifier = QLineEdit()
        self.identifier.setPlaceholderText("login email")
        self.identifier.setMinimumWidth(280)

        self.api_key = QLineEdit()
        self.api_key.setPlaceholderText("Capital.com API Key")
        self.api_key.setEchoMode(QLineEdit.EchoMode.Password)

        self.password = QLineEdit()
        self.password.setPlaceholderText("Capital.com API Password")
        self.password.setEchoMode(QLineEdit.EchoMode.Password)

        form_lay.addRow("IDENTIFIER", self.identifier)
        form_lay.addRow("API KEY", self.api_key)
        form_lay.addRow("API PASSWORD", self.password)

        btn_row = QHBoxLayout()

        self.btn_save = QPushButton("SAVE && CONNECT")
        self.btn_save.setObjectName("Primary")

        self.btn_test = QPushButton("TEST CONNECTION")
        self.btn_test.setObjectName("Action")

        self.btn_refresh = QPushButton("REFRESH")
        self.btn_refresh.setObjectName("Action")

        self.btn_sync = QPushButton("SYNC ACCOUNTS")
        self.btn_sync.setObjectName("Action")

        self.btn_pull = QPushButton("PULL CAPITAL MARKETS")
        self.btn_pull.setObjectName("Action")

        self.btn_disable = QPushButton("DISABLE")
        self.btn_disable.setObjectName("Warn")

        self.btn_remove = QPushButton("REMOVE")
        self.btn_remove.setObjectName("Danger")

        for b in (
            self.btn_save,
            self.btn_test,
            self.btn_refresh,
            self.btn_sync,
            self.btn_pull,
            self.btn_disable,
            self.btn_remove,
        ):
            btn_row.addWidget(b)
        btn_row.addStretch(1)

        self.status_label = QLabel("")
        self.status_label.setWordWrap(True)
        self.status_label.setObjectName("muted")

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(box)
        root.addLayout(btn_row)
        root.addWidget(self.status_label)

        self.btn_save.clicked.connect(self._save)
        self.btn_test.clicked.connect(self._test)
        self.btn_refresh.clicked.connect(self._refresh_broker)
        self.btn_sync.clicked.connect(self._sync_accounts)
        self.btn_pull.clicked.connect(self._pull_markets)
        self.btn_disable.clicked.connect(self._disable)
        self.btn_remove.clicked.connect(self._remove)

    def _set_status(self, text: str, tone: str = "neutral") -> None:
        self.status_label.setText(text)
        self.status_label.setProperty("tone", tone)
        self.status_label.style().unpolish(self.status_label)
        self.status_label.style().polish(self.status_label)

    def load_broker(self, broker_id: int) -> None:
        """Populate identifier from server (never retrieve secrets from server)."""
        self._broker_id = broker_id
        try:
            row = self.api.get(f"/api/brokers/{broker_id}") or {}
            self.identifier.setText(str(row.get("identifier") or ""))
            # Secrets are always masked on server — clear local fields
            self.api_key.clear()
            self.password.clear()
            env = str(row.get("environment") or "")
            enabled = row.get("enabled", True)
            self._set_status(
                f"broker_id={broker_id}  environment={env or 'not set'}  "
                f"{'ENABLED' if enabled else 'DISABLED'}"
            )
        except ApiError as e:
            self._set_status(str(e), "bad")

    def _save(self) -> None:
        identifier = self.identifier.text().strip()
        api_key = self.api_key.text().strip()
        password = self.password.text().strip()
        if not identifier:
            QMessageBox.warning(self, "VS Admin", "Identifier (login email) is required.")
            return
        if not api_key or not password:
            QMessageBox.warning(self, "VS Admin", "API Key and API Password are required.")
            return
        try:
            res = self.api.post(
                "/api/brokers",
                {
                    "broker_name": "capital_com",
                    "environment": "live",
                    "identifier": identifier,
                    "api_key": api_key,
                    "password": password,
                },
            ) or {}
        except ApiError as e:
            QMessageBox.critical(self, "SAVE FAILED", str(e))
            return

        # Clear secret fields immediately after successful save
        self.api_key.clear()
        self.password.clear()

        bid = res.get("id") or res.get("broker_connection_id")
        if bid:
            self._broker_id = int(bid)

        # Immediately test the saved connection
        if self._broker_id:
            try:
                test_res = self.api.post(f"/api/brokers/{self._broker_id}/test") or {}
            except ApiError as e:
                QMessageBox.critical(self, "SAVE OK — TEST FAILED", str(e))
                self._set_status(f"SAVED broker_id={self._broker_id} — TEST FAILED", "bad")
                return

            if test_res.get("success"):
                accounts = test_res.get("capital_accounts") or []
                names = ", ".join(
                    str(a.get("accountName") or a.get("accountId") or a) for a in accounts
                )
                detail = test_res.get("message") or "Connected."
                if names:
                    detail = f"{detail}\n\nCapital accounts: {names}"
                QMessageBox.information(self, "CONNECTED", detail)
                self._set_status(f"CONNECTED  broker_id={self._broker_id}", "ok")
            else:
                error = (
                    test_res.get("error")
                    or test_res.get("message")
                    or test_res.get("detail")
                    or str(test_res)
                )
                err_code = test_res.get("errorCode") or test_res.get("status") or ""
                msg = f"{error}"
                if err_code:
                    msg = f"[{err_code}] {msg}"
                QMessageBox.critical(self, "SAVE OK — CAPITAL CONNECTION FAILED", msg)
                self._set_status(f"SAVED broker_id={self._broker_id} — CONNECTION FAILED", "bad")
        else:
            msg = res.get("message") or res.get("detail") or "Saved."
            QMessageBox.information(self, "BROKER SAVED", msg)
            self._set_status("SAVED", "ok")

    def _test(self) -> None:
        if not self._broker_id:
            QMessageBox.warning(self, "VS Admin", "Save broker credentials first.")
            return
        try:
            res = self.api.post(f"/api/brokers/{self._broker_id}/test") or {}
        except ApiError as e:
            QMessageBox.critical(self, "TEST FAILED", str(e))
            self._set_status("TEST FAILED", "bad")
            return
        accounts = res.get("capital_accounts") or []
        detail = res.get("message") or res.get("detail") or str(res)
        if accounts:
            names = ", ".join(
                str(a.get("accountName") or a.get("accountId") or a) for a in accounts
            )
            detail = f"{detail}\n\nAccounts: {names}"
        QMessageBox.information(self, "TEST OK" if res.get("success") else "TEST RESULT", detail)
        self._set_status(
            "TEST OK" if res.get("success") else "TEST FAILED",
            "ok" if res.get("success") else "bad",
        )

    def _refresh_broker(self) -> None:
        if not self._broker_id:
            QMessageBox.warning(self, "VS Admin", "No broker loaded. Save or select a broker first.")
            return
        self.load_broker(self._broker_id)

    def _sync_accounts(self) -> None:
        if not self._broker_id:
            QMessageBox.warning(self, "VS Admin", "Save broker credentials first.")
            return
        try:
            res = self.api.post(f"/api/brokers/{self._broker_id}/test") or {}
        except ApiError as e:
            QMessageBox.critical(self, "SYNC FAILED", str(e))
            return
        accounts = res.get("capital_accounts") or []
        if accounts:
            names = "\n".join(
                f"  {a.get('accountName') or a.get('accountId') or a}" for a in accounts
            )
            QMessageBox.information(self, "ACCOUNTS SYNCED", f"Capital accounts:\n{names}")
        else:
            QMessageBox.warning(
                self, "SYNC", res.get("message") or "No accounts returned. Verify credentials."
            )

    def _pull_markets(self) -> None:
        if not self._broker_id:
            QMessageBox.warning(self, "VS Admin", "Save broker credentials first.")
            return
        try:
            res = self.api.post(f"/api/brokers/{self._broker_id}/pull-markets") or {}
        except ApiError as e:
            QMessageBox.critical(self, "PULL MARKETS FAILED", str(e))
            return
        count = res.get("count") or res.get("instruments_seeded") or 0
        QMessageBox.information(
            self,
            "MARKETS PULLED",
            res.get("message") or f"Capital market catalog refreshed. Instruments: {count}",
        )

    def _disable(self) -> None:
        if not self._broker_id:
            return
        if (
            QMessageBox.question(
                self,
                "DISABLE BROKER",
                "Disable this broker connection?\nThis will block new orders.",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        try:
            self.api.post(f"/api/brokers/{self._broker_id}/disable")
        except ApiError as e:
            QMessageBox.critical(self, "DISABLE FAILED", str(e))
            return
        self._set_status("DISABLED", "warn")

    def _remove(self) -> None:
        if not self._broker_id:
            return
        if (
            QMessageBox.question(
                self,
                "REMOVE BROKER",
                "Remove this broker connection permanently?\nEncrypted credentials will be deleted from the server.",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        try:
            self.api.request("DELETE", f"/api/brokers/{self._broker_id}")
        except ApiError as e:
            QMessageBox.critical(self, "REMOVE FAILED", str(e))
            return
        self._broker_id = None
        self.identifier.clear()
        self._set_status("REMOVED")


class BrokersPage(Page):
    def __init__(self, api: ControlApi):
        super().__init__("BROKERS")
        self.api = api
        self.set_note(
            "Capital.com LIVE credentials are stored encrypted on i3. "
            "Credentials are NEVER saved locally on this MSI machine."
        )

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        inner = QWidget()
        inner_lay = QVBoxLayout(inner)
        inner_lay.setContentsMargins(0, 0, 0, 0)
        inner_lay.setSpacing(16)

        self.form = BrokerForm(api)
        inner_lay.addWidget(self.form)

        p = Panel("CONFIGURED BROKER CONNECTIONS")
        self.table = VsTable(
            ["ID", "NAME", "ENVIRONMENT", "IDENTIFIER", "ENABLED", "CREATED"],
            ["id", "broker_name", "environment", "identifier", "enabled", "created_at"],
        )
        self.table.setMinimumHeight(160)
        p.body.addWidget(self.table)
        inner_lay.addWidget(p)
        inner_lay.addStretch(1)

        scroll.setWidget(inner)
        self.root.addWidget(scroll, 1)

        self.table.selectionModel().selectionChanged.connect(self._on_select)

    def _on_select(self) -> None:
        idx = self.table.currentIndex()
        if not idx.isValid():
            return
        row = self.table.model().rows[idx.row()]  # type: ignore[attr-defined]
        bid = row.get("id")
        if bid is not None:
            self.form.load_broker(int(bid))

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        brokers = s.get("brokers") or []
        rows = []
        for b in brokers:
            if not isinstance(b, dict):
                continue
            rows.append(
                {
                    "id": b.get("id") or "—",
                    "broker_name": b.get("broker_name") or "—",
                    "environment": b.get("environment") or "—",
                    "identifier": b.get("identifier") or "—",
                    "enabled": "YES" if b.get("enabled") else "NO",
                    "created_at": (str(b.get("created_at") or "—"))[:19],
                }
            )
        self.table.set_rows(rows)
