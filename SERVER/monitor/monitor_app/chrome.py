from __future__ import annotations

from typing import Any

from PySide6.QtCore import QAbstractTableModel, QModelIndex, Qt, QRect
from PySide6.QtGui import QColor, QPainter, QPainterPath
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QTableView,
    QVBoxLayout,
    QWidget,
)


def nd(value: Any, fallback: str = "NO DATA") -> str:
    if value is None or value == "":
        return fallback
    return str(value)


def cell(obj: Any, *keys: str) -> Any:
    cur = obj
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def tone_for(status: Any) -> str:
    s = str(status or "").upper()
    if s in ("ONLINE", "HEALTHY", "OK", "LIVE", "READY", "CONNECTED", "TRUE"):
        return "ok"
    if s in ("OFFLINE", "FAILED", "ERROR", "DISCONNECTED", "FALSE"):
        return "bad"
    if s:
        return "warn"
    return "neutral"


class KpiCard(QFrame):
    def __init__(self, title: str):
        super().__init__()
        self.setObjectName("KpiCard")
        lay = QVBoxLayout(self)
        lab = QLabel(title)
        lab.setObjectName("CardLabel")
        self.value = QLabel("NO DATA")
        self.value.setObjectName("CardValue")
        self.sub = QLabel("")
        self.sub.setObjectName("muted")
        self.sub.setWordWrap(True)
        lay.addWidget(lab)
        lay.addWidget(self.value)
        lay.addWidget(self.sub)

    def set_value(self, value: Any, *, sub: str = "", tone: str = "neutral") -> None:
        self.value.setText(nd(value))
        self.sub.setText(sub)
        self.value.setProperty("tone", tone)
        self.value.style().unpolish(self.value)
        self.value.style().polish(self.value)


class Panel(QFrame):
    def __init__(self, title: str):
        super().__init__()
        self.setObjectName("Card")
        self.body = QVBoxLayout(self)
        head = QLabel(title)
        head.setObjectName("Section")
        self.body.addWidget(head)


class MetricBar(QWidget):
    def __init__(self, label: str):
        super().__init__()
        self.label = label
        self.value: float | None = None
        self.setMinimumHeight(30)

    def set_value(self, value: float | None) -> None:
        self.value = value
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(), QColor("#0c1014"))
        p.setPen(QColor("#7d8882"))
        text = f"{self.label}  NO DATA" if self.value is None else f"{self.label}  {self.value:.0f}%"
        p.drawText(QRect(8, 0, 90, self.height()), Qt.AlignmentFlag.AlignVCenter, text)
        bar = QRect(100, 9, max(40, self.width() - 110), self.height() - 18)
        path = QPainterPath()
        path.addRoundedRect(bar, 4, 4)
        p.fillPath(path, QColor("#1c242c"))
        if self.value is not None:
            frac = max(0.0, min(1.0, float(self.value) / 100.0))
            color = QColor("#2ef28a") if self.value < 80 else QColor("#e6b84d") if self.value < 92 else QColor("#ff5a5a")
            fill = QRect(bar.x(), bar.y(), max(4, int(bar.width() * frac)), bar.height())
            fp = QPainterPath()
            fp.addRoundedRect(fill, 4, 4)
            p.fillPath(fp, color)
        p.end()


class DictTableModel(QAbstractTableModel):
    def __init__(self, headers: list[str], keys: list[str]):
        super().__init__()
        self.headers = headers
        self.keys = keys
        self.rows: list[dict] = []

    def set_rows(self, rows: list[dict]) -> None:
        self.beginResetModel()
        self.rows = rows
        self.endResetModel()

    def rowCount(self, parent=None) -> int:  # noqa: N802
        return len(self.rows)

    def columnCount(self, parent=None) -> int:  # noqa: N802
        return len(self.headers)

    def headerData(self, section, orientation, role=Qt.ItemDataRole.DisplayRole):  # noqa: N802
        if role != Qt.ItemDataRole.DisplayRole:
            return None
        if orientation == Qt.Orientation.Horizontal:
            return self.headers[section]
        return str(section + 1)

    def data(self, index: QModelIndex, role=Qt.ItemDataRole.DisplayRole):
        if not index.isValid() or role != Qt.ItemDataRole.DisplayRole:
            return None
        val = self.rows[index.row()].get(self.keys[index.column()])
        return "NO DATA" if val is None or val == "" else str(val)


class VsTable(QTableView):
    def __init__(self, headers: list[str], keys: list[str]):
        super().__init__()
        self.model_ref = DictTableModel(headers, keys)
        self.setModel(self.model_ref)
        self.horizontalHeader().setStretchLastSection(True)
        self.verticalHeader().setVisible(False)
        self.setAlternatingRowColors(True)
        self.setShowGrid(False)

    def set_rows(self, rows: list[dict]) -> None:
        self.model_ref.set_rows(rows)


class Kv(QWidget):
    def __init__(self, label: str):
        super().__init__()
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 2, 0, 2)
        self.key = QLabel(label)
        self.key.setObjectName("muted")
        self.val = QLabel("NO DATA")
        self.val.setAlignment(Qt.AlignmentFlag.AlignRight)
        row.addWidget(self.key)
        row.addWidget(self.val, 1)

    def set_value(self, value: Any, *, tone: str | None = None) -> None:
        self.val.setText(nd(value))
        if tone:
            self.val.setProperty("tone", tone)
            self.val.style().unpolish(self.val)
            self.val.style().polish(self.val)
