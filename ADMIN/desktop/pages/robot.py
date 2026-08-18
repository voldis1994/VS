"""Robot page — START/STOP Capital hands + live decision / pending calc / cross-market."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QComboBox,
    QDoubleSpinBox,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
)

from pages.base import Page
from services.api import ApiError, ControlApi
from widgets.chrome import KvRow, Panel, VsTable


class RobotPage(Page):
    def __init__(self, api: ControlApi):
        super().__init__("ROBOT")
        self.api = api
        self._accounts: list[dict] = []
        self._sessions: list[dict] = []
        self.set_note(
            "Robot is Capital hands. START executes queued calc (pipeline/C++) then Node fallback. "
            "STOP ends new entries; open trades keep managing until flat."
        )

        row = QHBoxLayout()
        self.account = QComboBox()
        self.account.setMinimumWidth(280)
        self.account.currentIndexChanged.connect(self._fill_from_account)
        self.lot = QDoubleSpinBox()
        self.lot.setRange(0.00001, 100_000.0)
        self.lot.setDecimals(5)
        self.lot.setValue(0.01)
        self.lot.setSingleStep(0.01)
        start = QPushButton("START")
        start.setObjectName("Primary")
        start.clicked.connect(self._start)
        stop = QPushButton("STOP")
        stop.clicked.connect(self._stop)
        row.addWidget(self.account, 1)
        row.addWidget(self.lot)
        row.addWidget(start)
        row.addWidget(stop)
        self.root.addLayout(row)

        self.lbl = QLabel("")
        self.lbl.setObjectName("muted")
        self.lbl.setWordWrap(True)
        self.root.addWidget(self.lbl)

        self.table = VsTable(
            ["ID", "CLIENT", "EPIC", "MODE", "SIDE", "CALC", "CROSS", "RUNNING"],
            ["id", "client", "epic", "mode", "side", "calc", "cross", "running"],
        )
        self.table.selectionModel().selectionChanged.connect(self._on_select)
        self.root.addWidget(self.table, 2)

        detail = Panel("SESSION")
        self.rows = {
            "decision": KvRow("DECISION"),
            "pending": KvRow("PENDING CALC"),
            "cross": KvRow("CROSS-MARKET"),
            "last": KvRow("LAST TICK"),
        }
        for w in self.rows.values():
            detail.body.addWidget(w)
        self.root.addWidget(detail)

        self.ticks = VsTable(["AT", "PHASE", "DETAIL"], ["at", "phase", "detail"])
        self.root.addWidget(self.ticks, 2)

    def apply(self, s: dict) -> None:
        self.mark_disconnected(s)
        self._accounts = []
        current = self.account.currentData()
        self.account.blockSignals(True)
        self.account.clear()
        for c in s.get("clients") or []:
            if not isinstance(c, dict) or not c.get("account_id"):
                continue
            acc = {
                "account_id": int(c["account_id"]),
                "client": c.get("name") or "—",
                "epic": c.get("panel_epic") or "",
                "lot": c.get("panel_lot_size"),
            }
            self._accounts.append(acc)
            label = f"{acc['client']} · acct {acc['account_id']} · {acc['epic'] or 'NO EPIC'}"
            self.account.addItem(label, acc["account_id"])
        if current is not None:
            idx = self.account.findData(current)
            if idx >= 0:
                self.account.setCurrentIndex(idx)
        self.account.blockSignals(False)
        self._fill_from_account()

        desk = s.get("robot_desk") if isinstance(s.get("robot_desk"), dict) else {}
        self._sessions = [x for x in (desk.get("sessions") or []) if isinstance(x, dict)]
        self.table.set_rows(
            [
                {
                    "id": sess.get("id"),
                    "client": sess.get("client_name") or sess.get("account_name") or "—",
                    "epic": sess.get("epic") or "—",
                    "mode": sess.get("mode") or "—",
                    "side": sess.get("open_side") or "FLAT",
                    "calc": (sess.get("pending_calc") or {}).get("direction")
                    if isinstance(sess.get("pending_calc"), dict)
                    else "—",
                    "cross": (sess.get("cross_market") or {}).get("detail")
                    if isinstance(sess.get("cross_market"), dict)
                    else "—",
                    "running": "YES" if sess.get("running") else "NO",
                }
                for sess in self._sessions
            ]
        )
        chain = (desk.get("board") or {}).get("chain") if isinstance(desk.get("board"), dict) else None
        if chain:
            self.lbl.setText(str(chain))
        if self.table.selectionModel().selectedRows():
            self._on_select()
        elif self._sessions:
            self._show_session(self._sessions[0])

    def _fill_from_account(self) -> None:
        idx = self.account.currentIndex()
        if idx < 0 or idx >= len(self._accounts):
            return
        lot = self._accounts[idx].get("lot")
        if lot is not None:
            try:
                self.lot.setValue(float(lot))
            except (TypeError, ValueError):
                pass

    def _selected_session(self) -> dict | None:
        indexes = self.table.selectionModel().selectedRows()
        if indexes:
            row = indexes[0].row()
            if 0 <= row < len(self._sessions):
                return self._sessions[row]
        return self._sessions[0] if self._sessions else None

    def _on_select(self) -> None:
        sess = self._selected_session()
        if sess:
            self._show_session(sess)

    def _show_session(self, sess: dict) -> None:
        chain = sess.get("decision_chain") if isinstance(sess.get("decision_chain"), dict) else {}
        action = chain.get("action") or sess.get("mode") or "—"
        self.rows["decision"].set_value(f"{action} · {chain.get('regime') or sess.get('regime') or '—'}")
        calc = sess.get("pending_calc") if isinstance(sess.get("pending_calc"), dict) else None
        if calc:
            self.rows["pending"].set_value(
                f"{calc.get('direction')} · {calc.get('setup_type') or calc.get('regime') or calc.get('explanation') or 'queued'}"
            )
        else:
            self.rows["pending"].set_value("NONE")
        xm = sess.get("cross_market") if isinstance(sess.get("cross_market"), dict) else None
        self.rows["cross"].set_value((xm or {}).get("detail") or "NO DATA")
        ticks = sess.get("ticks") if isinstance(sess.get("ticks"), list) else []
        last = ticks[0] if ticks and isinstance(ticks[0], dict) else {}
        self.rows["last"].set_value(last.get("detail") or "—")
        self.ticks.set_rows(
            [
                {
                    "at": t.get("at") or "—",
                    "phase": t.get("phase") or "—",
                    "detail": t.get("detail") or "—",
                }
                for t in ticks[:40]
                if isinstance(t, dict)
            ]
        )

    def _start(self) -> None:
        idx = self.account.currentIndex()
        if idx < 0 or idx >= len(self._accounts):
            QMessageBox.warning(self, "VS Admin", "Assign an EPIC on Accounts first")
            return
        acc = self._accounts[idx]
        epic = str(acc.get("epic") or "").strip()
        if not epic:
            QMessageBox.warning(self, "VS Admin", "This account has no EPIC — save one on Accounts")
            return
        try:
            res = self.api.post(
                "/api/robot-desk/start",
                {
                    "account_id": acc["account_id"],
                    "epic": epic,
                    "lot_size": round(self.lot.value(), 5),
                    "trading_enabled": True,
                    "entry_enabled": True,
                },
            ) or {}
            sess = res.get("session") if isinstance(res, dict) else None
            rid = (sess or {}).get("id") if isinstance(sess, dict) else None
            self.lbl.setText(f"STARTED {rid or epic}")
        except ApiError as e:
            QMessageBox.critical(self, "VS Admin", str(e))

    def _stop(self) -> None:
        sess = self._selected_session()
        if not sess or not sess.get("id"):
            QMessageBox.warning(self, "VS Admin", "No running robot to stop")
            return
        try:
            self.api.post(
                f"/api/robot-desk/{sess['id']}/stop",
                {"account_id": sess.get("account_id"), "epic": sess.get("epic")},
            )
            self.lbl.setText(f"STOPPED {sess.get('id')}")
        except ApiError as e:
            QMessageBox.critical(self, "VS Admin", str(e))
