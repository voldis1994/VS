from __future__ import annotations

from PySide6.QtWidgets import QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton, QTextEdit

from pages.base import Page
from services.api import ApiError
from ui.format import nd
from widgets.chrome import KvRow, Panel, VsTable


class LogsPage(Page):
    def __init__(self):
        super().__init__("LOGS")
        self.set_note("Operator journal from CORE monitor events. Full systemd journals stay on i3.")
        self.journal = QTextEdit()
        self.journal.setReadOnly(True)
        self.root.addWidget(self.journal, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        lines = []
        for ev in s.get("events") or []:
            if isinstance(ev, dict):
                lines.append(f"{ev.get('at') or ev.get('ts') or ''}  {ev.get('type') or ''}  {ev.get('message') or ev}")
            else:
                lines.append(str(ev))
        last = s.get("lastError") or s.get("error")
        if last:
            lines.insert(0, f"LAST  {last}")
        self.journal.setPlainText("\n".join(lines) if lines else "NO DATA")


class BackupsPage(Page):
    def __init__(self):
        super().__init__("BACKUPS")
        self.set_note("Backup status is published by VS CORE. This console does not invent backup success.")
        self.table = VsTable(["KEY", "VALUE"], ["k", "v"])
        self.root.addWidget(self.table, 1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        raw = (s.get("raw") or {}).get("backup") or s.get("backup")
        if not raw:
            self.table.set_rows([{"k": "STATUS", "v": "NO DATA — CORE has not published a backup payload"}])
            return
        if isinstance(raw, dict):
            self.table.set_rows([{"k": str(k), "v": v} for k, v in raw.items()])
        else:
            self.table.set_rows([{"k": "STATUS", "v": raw}])


class UpdatesPage(Page):
    def __init__(self):
        super().__init__("UPDATES")
        p = Panel("VERSIONS")
        self.server = KvRow("SERVER")
        self.admin = KvRow("ADMIN")
        self.build = KvRow("BUILD")
        self.api = KvRow("API")
        for w in (self.server, self.admin, self.build, self.api):
            p.body.addWidget(w)
        self.root.addWidget(p)
        self.root.addStretch(1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        raw = s.get("raw") or {}
        build = raw.get("build") or {}
        self.server.set_value(s.get("server_version") or build.get("version"))
        self.admin.set_value(s.get("adminVersion"))
        self.build.set_value(build.get("build_commit"))
        self.api.set_value(build.get("api_version"))


class SettingsPage(Page):
    def __init__(self):
        super().__init__("SETTINGS")
        self._api: object = None  # injected after construction via set_api()
        self.set_note(
            "Connection is owned by START_MSI.bat and ADMIN/config. "
            "LIVE control requires x-admin-token and full safety gate on i3."
        )

        # Connection panel
        p_conn = Panel("CONNECTION")
        self.server = KvRow("PINNED SERVER")
        self.transport = KvRow("TRANSPORT")
        self.state = KvRow("STATE")
        self.token = KvRow("ADMIN TOKEN")
        for w in (self.server, self.transport, self.state, self.token):
            p_conn.body.addWidget(w)
        self.root.addWidget(p_conn)

        # System status panel
        p_sys = Panel("SYSTEM STATUS")
        self.capital_row = KvRow("CAPITAL LIVE")
        self.feeds_row = KvRow("PUBLIC FEEDS")
        self.ohlc_row = KvRow("10S OHLC")
        self.money_row = KvRow("MONEY PATH")
        self.live_row = KvRow("LIVE TRADING")
        for w in (self.capital_row, self.feeds_row, self.ohlc_row, self.money_row, self.live_row):
            p_sys.body.addWidget(w)
        self.root.addWidget(p_sys)

        # LIVE control panel
        p_live = Panel("LIVE TRADING CONTROL")
        live_note = QLabel(
            "ENABLE LIVE requires: valid admin token · real Capital LIVE session · "
            "real account · money path READY · no default secrets."
        )
        live_note.setWordWrap(True)
        live_note.setObjectName("muted")
        p_live.body.addWidget(live_note)

        confirm_row = QHBoxLayout()
        self.confirm_input = QLineEdit()
        self.confirm_input.setPlaceholderText('Type "ENABLE LIVE" to confirm')
        self.confirm_input.setMinimumWidth(220)
        self.btn_enable_live = QPushButton("ENABLE LIVE")
        self.btn_enable_live.setObjectName("Warn")
        self.btn_disable_live = QPushButton("DISABLE LIVE")
        self.btn_disable_live.setObjectName("Danger")
        confirm_row.addWidget(self.confirm_input)
        confirm_row.addWidget(self.btn_enable_live)
        confirm_row.addWidget(self.btn_disable_live)
        confirm_row.addStretch(1)
        p_live.body.addLayout(confirm_row)

        self.live_status_label = QLabel("")
        self.live_status_label.setWordWrap(True)
        self.live_status_label.setObjectName("muted")
        p_live.body.addWidget(self.live_status_label)

        self.root.addWidget(p_live)
        self.root.addStretch(1)

        self.btn_enable_live.clicked.connect(self._enable_live)
        self.btn_disable_live.clicked.connect(self._disable_live)

    def set_api(self, api: object) -> None:
        self._api = api

    def _set_live_status(self, text: str, tone: str = "neutral") -> None:
        self.live_status_label.setText(text)
        self.live_status_label.setProperty("tone", tone)
        self.live_status_label.style().unpolish(self.live_status_label)
        self.live_status_label.style().polish(self.live_status_label)

    def _enable_live(self) -> None:
        if self._api is None:
            QMessageBox.warning(self, "VS Admin", "Not connected to server.")
            return
        confirmation = self.confirm_input.text().strip()
        if confirmation != "ENABLE LIVE":
            QMessageBox.warning(
                self, "VS Admin", 'Type exactly "ENABLE LIVE" in the confirmation field first.'
            )
            return
        # Show what we're about to do
        if (
            QMessageBox.question(
                self,
                "ENABLE LIVE TRADING",
                "Enable LIVE trading on i3?\n\n"
                "This will:\n"
                "1. Verify Capital.com LIVE session\n"
                "2. Verify real account exists\n"
                "3. Verify money path is READY\n"
                "4. Persist LIVE_TRADING_ENABLED=true to server.env\n\n"
                "No robot will be started automatically.",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        try:
            res = self._api.post(  # type: ignore[attr-defined]
                "/api/admin/live-control/enable",
                {"confirmation": "ENABLE LIVE"},
            ) or {}
        except ApiError as e:
            QMessageBox.critical(self, "ENABLE FAILED", str(e))
            self._set_live_status(f"ENABLE FAILED: {e}", "bad")
            return
        self.confirm_input.clear()
        msg = res.get("message") or "LIVE ENABLED"
        acct = res.get("capital_account") or ""
        full_msg = f"{msg}"
        if acct:
            full_msg = f"CAPITAL ACCOUNT: {acct}\n\n{msg}"
        QMessageBox.information(self, "LIVE ENABLED", full_msg)
        self._set_live_status("LIVE TRADING ENABLED", "ok")

    def _disable_live(self) -> None:
        if self._api is None:
            QMessageBox.warning(self, "VS Admin", "Not connected to server.")
            return
        if (
            QMessageBox.question(
                self,
                "DISABLE LIVE TRADING",
                "Disable LIVE trading?\nNew entries will be blocked immediately.",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        try:
            res = self._api.post("/api/admin/live-control/disable") or {}  # type: ignore[attr-defined]
        except ApiError as e:
            QMessageBox.critical(self, "DISABLE FAILED", str(e))
            return
        QMessageBox.information(
            self, "LIVE DISABLED", res.get("message") or "LIVE trading disabled."
        )
        self._set_live_status("LIVE TRADING DISABLED", "bad")

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        self.server.set_value(s.get("url"))
        self.transport.set_value(s.get("transport"))
        self.state.set_value(s.get("state"))
        self.token.set_value("SET" if s.get("url") else "NO DATA")

        # System status
        broker = s.get("broker") or {}
        broker_state = broker.get("state") or "NO DATA"
        is_connected = broker_state in ("CONNECTED", "OK", "LIVE")
        self.capital_row.set_value(
            broker_state,
            tone="ok" if is_connected else "bad",
        )

        feeds = s.get("feeds") or {}
        live_feeds = sum(
            1 for v in feeds.values()
            if isinstance(v, dict) and (v.get("status") or "").upper() in ("LIVE", "OK", "PUBLIC_LIVE")
        )
        total_feeds = len(feeds)
        feed_text = f"{live_feeds}/{total_feeds} LIVE" if total_feeds else "NO DATA"
        self.feeds_row.set_value(feed_text, tone="ok" if live_feeds > 0 else "neutral")

        raw = s.get("raw") or {}
        ohlc = raw.get("ohlc") or raw.get("canonical") or s.get("ohlc") or {}
        ohlc_state = ohlc.get("state") or ("LIVE" if ohlc.get("close") else "NO DATA")
        self.ohlc_row.set_value(ohlc_state, tone="ok" if ohlc_state == "LIVE" else "neutral")

        mp = s.get("money_path_ready") or s.get("moneyPathReady")
        self.money_row.set_value(
            "READY" if mp else "BLOCKED",
            tone="ok" if mp else "bad",
        )

        live_on = s.get("live_trading_enabled") or s.get("liveEnabled")
        self.live_row.set_value(
            "ENABLED" if live_on else "DISABLED",
            tone="ok" if live_on else "bad",
        )

