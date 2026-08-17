from __future__ import annotations

from PySide6.QtWidgets import QFormLayout, QLabel, QWidget

from pages.resource import ResourcePage


class SettingsPage(ResourcePage):
    def __init__(self) -> None:
        super().__init__("SETTINGS")
        extra = QWidget()
        form = QFormLayout(extra)
        self.server = QLabel("—")
        self.transport = QLabel("—")
        self.admin_ver = QLabel("1.0.0")
        self.note = QLabel("Connection is owned by START_MSI.bat / ADMIN/config. This panel does not contain trading logic.")
        self.note.setWordWrap(True)
        self.note.setObjectName("muted")
        form.addRow("Pinned server", self.server)
        form.addRow("Transport", self.transport)
        form.addRow("Admin version", self.admin_ver)
        form.addRow("", self.note)
        self.layout().insertWidget(1, extra)

    def apply(self, snapshot: dict) -> None:
        super().apply(snapshot)
        self.server.setText(str(snapshot.get("url") or "—"))
        self.transport.setText(str(snapshot.get("transport") or "—"))
