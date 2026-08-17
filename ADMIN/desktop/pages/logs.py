from __future__ import annotations

from PySide6.QtWidgets import QLabel, QTextEdit, QVBoxLayout, QWidget

from pages.resource import ResourcePage


class LogsPage(ResourcePage):
    def __init__(self) -> None:
        super().__init__("LOGS")
        extra = QWidget()
        lay = QVBoxLayout(extra)
        lay.setContentsMargins(0, 0, 0, 0)
        hint = QLabel("Operator journal from CORE monitor events. Full systemd journals stay on i3.")
        hint.setObjectName("muted")
        hint.setWordWrap(True)
        self.journal = QTextEdit()
        self.journal.setReadOnly(True)
        lay.addWidget(hint)
        lay.addWidget(self.journal)
        self.layout().insertWidget(1, extra)

    def apply(self, snapshot: dict) -> None:
        super().apply(snapshot)
        events = snapshot.get("events") or []
        lines = []
        for ev in events[:80]:
            if isinstance(ev, dict):
                lines.append(f"{ev.get('at') or ev.get('ts') or ''}  {ev.get('type') or ev.get('message') or ev}")
            else:
                lines.append(str(ev))
        self.journal.setPlainText("\n".join(lines) if lines else "No events.")
