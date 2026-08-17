"""Native VS chrome widgets shared across Admin pages."""
from __future__ import annotations

from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from models.table_model import DictTableModel
from ui.format import nd
from widgets.metric_bar import MetricBar


class KpiCard(QFrame):
    def __init__(self, title: str):
        super().__init__()
        self.setObjectName("KpiCard")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 12, 14, 12)
        lab = QLabel(title)
        lab.setObjectName("CardLabel")
        self.value = QLabel("NO DATA")
        self.value.setObjectName("CardValue")
        self.sub = QLabel("")
        self.sub.setObjectName("muted")
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
        self.body.setContentsMargins(14, 12, 14, 12)
        self.body.setSpacing(8)
        head = QLabel(title)
        head.setObjectName("Section")
        self.body.addWidget(head)

    def add_stretch(self) -> None:
        self.body.addStretch(1)


class KvRow(QWidget):
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


class FeedPills(QWidget):
    def __init__(self):
        super().__init__()
        self.lay = QHBoxLayout(self)
        self.lay.setContentsMargins(0, 0, 0, 0)
        self.lay.setSpacing(8)
        self.placeholder = QLabel("FEED HEALTH — NO DATA")
        self.placeholder.setObjectName("muted")
        self.lay.addWidget(self.placeholder)
        self.lay.addStretch(1)
        self.pills: list[QLabel] = []

    def set_feeds(self, feeds: dict) -> None:
        for p in self.pills:
            p.deleteLater()
        self.pills = []
        if not feeds:
            self.placeholder.setText("FEED HEALTH — NO DATA")
            self.placeholder.show()
            return
        self.placeholder.hide()
        for name, cell in feeds.items():
            status = cell.get("status") if isinstance(cell, dict) else cell
            lab = QLabel(f"  {name.upper()}  {nd(status)}  ")
            st = str(status or "").upper()
            tone = "ok" if st in ("OK", "ONLINE", "HEALTHY", "LIVE") else "bad" if st in ("ERROR", "OFFLINE", "FAILED") else "warn"
            lab.setObjectName("pill")
            lab.setProperty("tone", tone)
            self.lay.insertWidget(self.lay.count() - 1, lab)
            self.pills.append(lab)


class VsTable(QTableView):
    def __init__(self, headers: list[str], keys: list[str]):
        super().__init__()
        self.model_ref = DictTableModel(headers, keys)
        self.setModel(self.model_ref)
        self.horizontalHeader().setStretchLastSection(True)
        self.verticalHeader().setVisible(False)
        self.setAlternatingRowColors(True)
        self.setSelectionBehavior(QTableView.SelectionBehavior.SelectRows)
        self.setShowGrid(False)

    def set_rows(self, rows: list[dict]) -> None:
        self.model_ref.set_rows(rows)


class ResourceGauges(QWidget):
    def __init__(self):
        super().__init__()
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.cpu = MetricBar("CPU")
        self.ram = MetricBar("RAM")
        self.ssd = MetricBar("SSD")
        self.net = QLabel("NETWORK  NO DATA")
        self.net.setObjectName("muted")
        lay.addWidget(self.cpu)
        lay.addWidget(self.ram)
        lay.addWidget(self.ssd)
        lay.addWidget(self.net)

    def apply(self, snap: dict) -> None:
        self.cpu.set_value(snap.get("cpu") if isinstance(snap.get("cpu"), (int, float)) else None)
        self.ram.set_value(snap.get("ram") if isinstance(snap.get("ram"), (int, float)) else None)
        self.ssd.set_value(snap.get("disk") if isinstance(snap.get("disk"), (int, float)) else None)
        self.net.setText(f"NETWORK  {nd(snap.get('network'))}")
