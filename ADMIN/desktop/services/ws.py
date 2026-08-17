"""Optional WebSocket to Control API /ws. Failure never closes the Admin window."""
from __future__ import annotations

from PySide6.QtCore import QObject, QUrl, Signal, Slot
from PySide6.QtWebSockets import QWebSocket


class RealtimeSocket(QObject):
    opened = Signal()
    closed = Signal(str)
    message = Signal(str)

    def __init__(self, http_base: str, parent: QObject | None = None) -> None:
        super().__init__(parent)
        ws = http_base.replace("https://", "wss://").replace("http://", "ws://").rstrip("/")
        self.url = QUrl(ws + "/ws")
        self.sock = QWebSocket()
        self.sock.connected.connect(self.opened.emit)
        self.sock.disconnected.connect(lambda: self.closed.emit("disconnected"))
        self.sock.errorOccurred.connect(lambda err: self.closed.emit(str(err)))
        self.sock.textMessageReceived.connect(self.message.emit)

    @Slot()
    def open(self) -> None:
        self.sock.open(self.url)

    @Slot()
    def close(self) -> None:
        self.sock.close()
