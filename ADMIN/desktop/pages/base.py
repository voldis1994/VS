from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QLabel, QVBoxLayout, QWidget

from ui.format import nd


class Page(QWidget):
    title = ""

    def __init__(self, title: str):
        super().__init__()
        self.title = title
        self.root = QVBoxLayout(self)
        self.root.setContentsMargins(18, 16, 18, 16)
        self.root.setSpacing(12)
        head = QLabel(title)
        head.setObjectName("workspaceTitle")
        self.root.addWidget(head)
        self.note = QLabel("")
        self.note.setObjectName("muted")
        self.note.setWordWrap(True)
        self.root.addWidget(self.note)

    def set_note(self, text: str) -> None:
        self.note.setText(text)
        self.note.setVisible(bool(text))

    def mark_disconnected(self, snap: dict) -> bool:
        if snap.get("connected"):
            self.set_note("")
            return False
        state = nd(snap.get("state") or snap.get("connectionPhase"), "DISCONNECTED")
        self.set_note(f"{state} — waiting for VS-CORE-01. Values below are last live payload or NO DATA.")
        return True
