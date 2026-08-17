from __future__ import annotations

from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import QWidget


class MetricBar(QWidget):
    def __init__(self, label: str):
        super().__init__()
        self.label = label
        self.value: float | None = None
        self.setMinimumHeight(28)

    def set_value(self, value: float | None) -> None:
        self.value = value
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(), QColor("#0c1014"))
        p.setPen(QColor("#7d8882"))
        text = f"{self.label}  NO DATA" if self.value is None else f"{self.label}  {self.value:.0f}%"
        p.drawText(QRect(8, 0, 120, self.height()), Qt.AlignmentFlag.AlignVCenter, text)
        bar = QRect(130, 8, max(40, self.width() - 140), self.height() - 16)
        p.fillRect(bar, QColor("#1c242c"))
        if self.value is not None:
            frac = max(0.0, min(1.0, float(self.value) / 100.0))
            color = QColor("#2ef28a") if self.value < 80 else QColor("#e6b84d") if self.value < 92 else QColor("#ff5a5a")
            fill = QRect(bar.x(), bar.y(), int(bar.width() * frac), bar.height())
            p.fillRect(fill, color)
        p.end()
