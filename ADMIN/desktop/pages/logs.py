from __future__ import annotations

from PySide6.QtWidgets import QTextEdit

from pages.base import Page
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
        self.set_note(
            "Connection is owned by START_MSI.bat and ADMIN/config. This panel is an operator view only — no trading logic."
        )
        p = Panel("CONNECTION")
        self.server = KvRow("PINNED SERVER")
        self.transport = KvRow("TRANSPORT")
        self.state = KvRow("STATE")
        self.token = KvRow("ADMIN TOKEN")
        for w in (self.server, self.transport, self.state, self.token):
            p.body.addWidget(w)
        self.root.addWidget(p)
        self.root.addStretch(1)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        self.server.set_value(s.get("url"))
        self.transport.set_value(s.get("transport"))
        self.state.set_value(s.get("state"))
        self.token.set_value("SET" if s.get("url") else "NO DATA")
