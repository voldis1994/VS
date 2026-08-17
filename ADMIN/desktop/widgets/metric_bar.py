from __future__ import annotations

from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QColor, QPainter, QPainterPath
from PySide6.QtWidgets import QWidget


class MetricBar(QWidget):
    def __init__(self, label: str):
        super().__init__()
        self.label = label
        self.value: float | None = None
        self.setMinimumHeight(32)
        self.setMinimumWidth(180)

    def set_value(self, value: float | None) -> None:
        self.value = value
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(), QColor("#0c1014"))
        p.setPen(QColor("#7d8882"))
        text = f"{self.label}  NO DATA" if self.value is None else f"{self.label}  {self.value:.0f}%"
        p.drawText(QRect(10, 0, 110, self.height()), Qt.AlignmentFlag.AlignVCenter, text)
        bar = QRect(120, 10, max(40, self.width() - 130), self.height() - 20)
        path = QPainterPath()
        path.addRoundedRect(bar, 4, 4)
        p.fillPath(path, QColor("#1c242c"))
        if self.value is not None:
            frac = max(0.0, min(1.0, float(self.value) / 100.0))
            color = QColor("#2ef28a") if self.value < 80 else QColor("#e6b84d") if self.value < 92 else QColor("#ff5a5a")
            fill = QRect(bar.x(), bar.y(), max(4, int(bar.width() * frac)), bar.height())
            fpath = QPainterPath()
            fpath.addRoundedRect(fill, 4, 4)
            p.fillPath(fpath, color)
        p.end()
