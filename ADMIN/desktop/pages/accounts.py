"""Accounts page — per-client Capital EPIC assignment.

Flow: select account row → panel opens → LOAD CATALOG → search / pick EPIC
→ set lot size → SAVE EPIC → chips update instantly.
"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDoubleSpinBox,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
)

from pages.base import Page
from services.api import ApiError, ControlApi
from widgets.chrome import VsTable

_CARD_QSS = "background:#0e1318;border:1px solid #1c242c;border-radius:6px;"
_SPIN_QSS = (
    "QDoubleSpinBox{background:#0b1014;border:1px solid #1c242c;"
    "color:#eef3f0;padding:6px 8px;border-radius:6px;font-size:13px;}"
    "QDoubleSpinBox::up-button,QDoubleSpinBox::down-button{width:18px;}"
)


def _make_chip(label: str, default: str = "—") -> tuple[QFrame, QLabel]:
    """Labeled value card.  Returns (frame, value_label) so callers can update."""
    f = QFrame()
    f.setStyleSheet(_CARD_QSS)
    f.setMinimumWidth(175)
    lay = QVBoxLayout(f)
    lay.setContentsMargins(12, 10, 12, 10)
    lay.setSpacing(3)
    lbl = QLabel(label)
    lbl.setObjectName("CardLabel")
    val = QLabel(default)
    val.setStyleSheet("font-size:15px;font-weight:700;letter-spacing:0.5px;")
    lay.addWidget(lbl)
    lay.addWidget(val)
    return f, val


def _tone(widget: QLabel, tone: str) -> None:
    colors = {"ok": "#2ef28a", "warn": "#e6b84d", "bad": "#ff5a5a", "neutral": "#eef3f0"}
    widget.setStyleSheet(
        f"font-size:15px;font-weight:700;letter-spacing:0.5px;color:{colors.get(tone,'#eef3f0')};"
    )


class AccountsPage(Page):
    def __init__(self, api: ControlApi):
        super().__init__("ACCOUNTS")
        self.api = api

        # Runtime state
        self._accounts: list[dict] = []      # rows from live snapshot
        self._markets: list[dict] = []       # loaded Capital catalog (full)
        self._filtered: list[dict] = []      # after search filter
        self._current_account_id: int | None = None
        self._selected_market_id: int | None = None

        self.set_note(
            "Select a trading account to assign its Capital market (EPIC).  "
            "Each account must have exactly one EPIC before trading can start."
        )

        # ── Account list table ───────────────────────────────────────────────
        self.table = VsTable(
            ["CLIENT", "ACCOUNT", "SELECTED EPIC", "LOT", "TRADING"],
            ["client", "account", "epic", "lot", "trading"],
        )
        self.table.selectionModel().selectionChanged.connect(self._on_row_selected)
        self.root.addWidget(self.table, 2)

        # ── Assignment panel (hidden until row selected) ─────────────────────
        self.panel = QFrame()
        self.panel.setStyleSheet(_CARD_QSS)
        self.panel.setVisible(False)
        pl = QVBoxLayout(self.panel)
        pl.setContentsMargins(18, 14, 18, 14)
        pl.setSpacing(10)

        self.panel_title = QLabel("ASSIGN CAPITAL MARKET")
        self.panel_title.setObjectName("Section")
        pl.addWidget(self.panel_title)

        # Current-selection chips row
        chips_row = QHBoxLayout()
        chips_row.setSpacing(10)
        self._frame_epic, self._val_epic = _make_chip("SELECTED EPIC", "NOT SET")
        self._frame_lot, self._val_lot = _make_chip("LOT", "—")
        self._frame_trade, self._val_trade = _make_chip("TRADING ENABLED", "NOT SET")
        for f in (self._frame_epic, self._frame_lot, self._frame_trade):
            chips_row.addWidget(f)
        chips_row.addStretch(1)
        pl.addLayout(chips_row)

        # Search + load row
        search_row = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setPlaceholderText("Search EPIC or market name…")
        self.search.textChanged.connect(self._on_search)
        self.btn_load = QPushButton("LOAD CATALOG")
        self.btn_load.setObjectName("Primary")
        self.btn_load.clicked.connect(self._load_catalog)
        self.lbl_load = QLabel("")
        self.lbl_load.setObjectName("muted")
        search_row.addWidget(self.search, 1)
        search_row.addWidget(self.btn_load)
        search_row.addWidget(self.lbl_load)
        pl.addLayout(search_row)

        # Market results table
        self.mkt_table = QTableWidget(0, 4)
        self.mkt_table.setHorizontalHeaderLabels(["EPIC", "NAME", "CATEGORY", "MIN LOT"])
        self.mkt_table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch
        )
        for col in (0, 2, 3):
            self.mkt_table.horizontalHeader().setSectionResizeMode(
                col, QHeaderView.ResizeMode.ResizeToContents
            )
        self.mkt_table.verticalHeader().setVisible(False)
        self.mkt_table.setAlternatingRowColors(True)
        self.mkt_table.setSelectionBehavior(
            QAbstractItemView.SelectionBehavior.SelectRows
        )
        self.mkt_table.setEditTriggers(
            QAbstractItemView.EditTrigger.NoEditTriggers
        )
        self.mkt_table.setShowGrid(False)
        self.mkt_table.setMaximumHeight(230)
        self.mkt_table.itemSelectionChanged.connect(self._on_market_selected)
        pl.addWidget(self.mkt_table)

        # Lot + save row
        save_row = QHBoxLayout()
        lot_lbl = QLabel("LOT SIZE")
        lot_lbl.setObjectName("muted")
        self.lot_spin = QDoubleSpinBox()
        self.lot_spin.setStyleSheet(_SPIN_QSS)
        self.lot_spin.setRange(0.00001, 100_000.0)
        self.lot_spin.setDecimals(5)
        self.lot_spin.setValue(0.01)
        self.lot_spin.setSingleStep(0.01)
        self.lot_spin.setFixedWidth(140)
        self.btn_save = QPushButton("SAVE EPIC")
        self.btn_save.setObjectName("Primary")
        self.btn_save.setEnabled(False)
        self.btn_save.clicked.connect(self._save_epic)
        self.lbl_save = QLabel("")
        self.lbl_save.setObjectName("muted")
        save_row.addWidget(lot_lbl)
        save_row.addWidget(self.lot_spin)
        save_row.addSpacing(8)
        save_row.addWidget(self.btn_save)
        save_row.addWidget(self.lbl_save, 1)
        pl.addLayout(save_row)

        self.root.addWidget(self.panel, 3)

    # ── Live snapshot ─────────────────────────────────────────────────────────

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        self._accounts = []
        rows = []
        for c in s.get("clients") or []:
            if not isinstance(c, dict):
                continue
            acc_id = c.get("account_id")
            epic = c.get("panel_epic") or ""
            lot = c.get("panel_lot_size")
            self._accounts.append(
                {
                    "account_id": acc_id,
                    "client_name": c.get("name") or "—",
                    "display_name": c.get("account_name") or str(acc_id or "—"),
                }
            )
            rows.append(
                {
                    "client": c.get("name") or "—",
                    "account": str(acc_id or c.get("account_name") or "—"),
                    "epic": epic or "NOT SET",
                    "lot": str(lot) if lot is not None else "—",
                    "trading": "✓  ENABLED" if epic else "—  NOT SET",
                }
            )
        self.table.set_rows(rows)

    # ── Row selection ─────────────────────────────────────────────────────────

    def _on_row_selected(self) -> None:
        indexes = self.table.selectionModel().selectedRows()
        if not indexes:
            self.panel.setVisible(False)
            return
        row = indexes[0].row()
        if row >= len(self._accounts):
            return

        acc = self._accounts[row]
        acc_id = acc.get("account_id")
        if not acc_id:
            self.panel.setVisible(False)
            return

        self._current_account_id = int(acc_id)
        self._markets = []
        self._filtered = []
        self._selected_market_id = None
        self.btn_save.setEnabled(False)
        self.lbl_save.setText("")
        self.lbl_load.setText("Catalog not loaded — click LOAD CATALOG")
        self.search.clear()
        self.mkt_table.setRowCount(0)

        client_name = acc["client_name"]
        display_name = acc["display_name"]
        self.panel_title.setText(
            f"ASSIGN CAPITAL MARKET  ·  {client_name} / {display_name}"
        )
        self.panel.setVisible(True)
        self._refresh_chips()

    # ── Selected-market chip refresh ──────────────────────────────────────────

    def _refresh_chips(self) -> None:
        if not self._current_account_id:
            return
        try:
            data = (
                self.api.get(
                    f"/api/trading/accounts/{self._current_account_id}/selected-market"
                )
                or {}
            )
            sel = data.get("selected")
            if sel and sel.get("epic"):
                self._val_epic.setText(str(sel["epic"]))
                _tone(self._val_epic, "ok")
                lot = sel.get("lot_size")
                self._val_lot.setText(str(lot) if lot is not None else "—")
                _tone(self._val_lot, "neutral")
                self._val_trade.setText("ENABLED")
                _tone(self._val_trade, "ok")
            else:
                self._val_epic.setText("NOT SET")
                _tone(self._val_epic, "bad")
                self._val_lot.setText("—")
                _tone(self._val_lot, "neutral")
                self._val_trade.setText("NOT SET")
                _tone(self._val_trade, "bad")
        except ApiError as e:
            self._val_epic.setText(f"ERR: {e}")
            _tone(self._val_epic, "warn")

    # ── Catalog load ─────────────────────────────────────────────────────────

    def _load_catalog(self) -> None:
        if not self._current_account_id:
            return
        self.btn_load.setEnabled(False)
        self.lbl_load.setText("Loading…")
        self.mkt_table.setRowCount(0)
        try:
            data = (
                self.api.get(
                    f"/api/trading/accounts/{self._current_account_id}/instruments"
                )
                or []
            )
            self._markets = data if isinstance(data, list) else []
            self._filtered = list(self._markets)
            self._render_markets(self._filtered)
            self.lbl_load.setText(f"{len(self._markets)} markets loaded")
        except ApiError as e:
            self.lbl_load.setText(f"Error: {e}")
            QMessageBox.critical(self, "VS Admin", f"Failed to load catalog:\n{e}")
        finally:
            self.btn_load.setEnabled(True)

    # ── Market search filter ──────────────────────────────────────────────────

    def _on_search(self, text: str) -> None:
        needle = text.strip().lower()
        if not needle:
            self._filtered = list(self._markets)
        else:
            self._filtered = [
                m
                for m in self._markets
                if needle in str(m.get("epic") or "").lower()
                or needle in str(m.get("display_name") or "").lower()
            ]
        self._render_markets(self._filtered)

    # ── Render market rows ────────────────────────────────────────────────────

    def _render_markets(self, markets: list[dict]) -> None:
        self.mkt_table.setRowCount(0)
        for m in markets:
            r = self.mkt_table.rowCount()
            self.mkt_table.insertRow(r)
            epic = str(m.get("epic") or "")
            name = str(m.get("display_name") or "")
            cat = str(m.get("category") or "")
            min_lot = str(m.get("min_lot") or "")
            market_id = m.get("instrument_id")
            is_selected = bool(m.get("trading_enabled"))

            for col, txt in enumerate([epic, name, cat, min_lot]):
                item = QTableWidgetItem(txt)
                if col == 0:
                    item.setData(Qt.ItemDataRole.UserRole, market_id)
                if is_selected:
                    item.setForeground(Qt.GlobalColor.green)
                self.mkt_table.setItem(r, col, item)

    # ── Market row selection ──────────────────────────────────────────────────

    def _on_market_selected(self) -> None:
        row = self.mkt_table.currentRow()
        if row < 0:
            self._selected_market_id = None
            self.btn_save.setEnabled(False)
            return
        item = self.mkt_table.item(row, 0)
        if not item:
            return
        market_id = item.data(Qt.ItemDataRole.UserRole)
        if market_id is not None:
            self._selected_market_id = int(market_id)
            self.btn_save.setEnabled(True)
            self.lbl_save.setText(
                f"Selected: {item.text()}"
                + (f"  ·  min lot {self.mkt_table.item(row, 3).text()}" if self.mkt_table.item(row, 3) else "")
            )
            # Pre-fill lot with min_lot from catalog row
            min_lot_item = self.mkt_table.item(row, 3)
            if min_lot_item:
                try:
                    self.lot_spin.setValue(float(min_lot_item.text()))
                except ValueError:
                    pass

    # ── Save ─────────────────────────────────────────────────────────────────

    def _save_epic(self) -> None:
        if not self._current_account_id or self._selected_market_id is None:
            return
        lot = round(self.lot_spin.value(), 5)
        self.btn_save.setEnabled(False)
        self.lbl_save.setText("Saving…")
        try:
            self.api.put(
                f"/api/trading/accounts/{self._current_account_id}/selected-market",
                {"capital_market_id": self._selected_market_id, "lot_size": lot},
            )
            self.lbl_save.setText("✓  EPIC saved successfully")
            # Refresh chips to reflect new selection
            self._refresh_chips()
            # Re-render table to update green highlight
            needle = self.search.text()
            self._on_search(needle)
        except ApiError as e:
            self.lbl_save.setText(f"Error: {e}")
            QMessageBox.critical(self, "VS Admin", f"Failed to save EPIC:\n{e}")
        finally:
            self.btn_save.setEnabled(self._selected_market_id is not None)
