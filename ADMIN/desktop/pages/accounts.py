from __future__ import annotations

from PySide6.QtWidgets import QLabel, QVBoxLayout, QWidget

from pages.resource import ResourcePage


class AccountsPage(ResourcePage):
    def __init__(self) -> None:
        super().__init__("ACCOUNTS")
        extra = QWidget()
        lay = QVBoxLayout(extra)
        lay.setContentsMargins(0, 0, 0, 0)
        self.note = QLabel("Client trading accounts are provisioned from CLIENTS. This view shows live CORE account/position state.")
        self.note.setWordWrap(True)
        self.note.setObjectName("muted")
        lay.addWidget(self.note)
        self.layout().insertWidget(1, extra)
