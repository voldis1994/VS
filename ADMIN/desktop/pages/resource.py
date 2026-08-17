from __future__ import annotations

from PySide6.QtWidgets import QLabel, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget


class ResourcePage(QWidget):
    def __init__(self, title: str, kind: str | None = None):
        super().__init__()
        self.kind = (kind or title).lower()
        root = QVBoxLayout(self)
        h = QLabel(title)
        h.setObjectName("Section")
        root.addWidget(h)
        self.body = QLabel("NO DATA")
        self.body.setWordWrap(True)
        root.addWidget(self.body)
        self.table = QTableWidget(0, 4)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.verticalHeader().setVisible(False)
        root.addWidget(self.table, 1)

    def apply(self, s: dict) -> None:
        if not s.get("connected"):
            self.body.setText(f"{s.get('connectionPhase') or s.get('state') or 'DISCONNECTED'} — reconnecting to VS-CORE-01")
            self.table.setRowCount(0)
            return
        raw = s.get("raw") or {}
        if self.kind == "server":
            self.body.setText(
                f"SERVER {s.get('serverId') or s.get('server_id')}\n"
                f"HEALTH {s.get('health')}\n"
                f"UPTIME {s.get('uptime') or 'NO DATA'}\n"
                f"VERSION {s.get('serverVersion') or s.get('server_version') or 'NO DATA'}"
            )
            self._fill(
                ["KEY", "VALUE"],
                [
                    ["api", str((raw.get("api") or {}).get("status") or "NO DATA")],
                    ["database", str((raw.get("database") or {}).get("status") or "NO DATA")],
                    ["redis", str((raw.get("redis") or {}).get("status") or "NO DATA")],
                    ["network", str(s.get("network") or "NO DATA")],
                ],
            )
            return
        if self.kind == "market":
            self.body.setText(
                f"{s.get('marketStatus')}\n{s.get('marketDetail')}\n"
                f"bid {s.get('marketBid') if s.get('marketBid') is not None else 'NO DATA'}  "
                f"ask {s.get('marketAsk') if s.get('marketAsk') is not None else 'NO DATA'}"
            )
            feeds = s.get("feeds") or {}
            data = []
            for name, cell in feeds.items():
                if isinstance(cell, dict):
                    data.append([name, str(cell.get("status") or "NO DATA"), str(cell.get("detail") or ""), ""])
                else:
                    data.append([name, str(cell), "", ""])
            self._fill(["FEED", "STATUS", "DETAIL", ""], data)
            return
        if self.kind == "positions":
            rows = s.get("positions") or []
            self.body.setText("OPEN POSITIONS" if rows else "NO OPEN POSITIONS")
            data = []
            for p in rows:
                data.append(
                    [
                        str(p.get("symbol") or p.get("market") or "—"),
                        str(p.get("side") or "—"),
                        str(p.get("size") or p.get("lot") or "—"),
                        str(p.get("pnl") if p.get("pnl") is not None else "NO DATA"),
                    ]
                )
            self._fill(["SYMBOL", "SIDE", "LOT", "P/L"], data)
            return
        if self.kind in ("orders", "trades"):
            rows = s.get(self.kind) or []
            self.body.setText(f"{len(rows)} {self.kind.upper()}" if rows else f"NO {self.kind.upper()}")
            data = []
            for p in rows:
                if not isinstance(p, dict):
                    data.append([str(p), "", "", ""])
                    continue
                data.append(
                    [
                        str(p.get("id") or p.get("order_id") or p.get("trade_id") or "—"),
                        str(p.get("side") or "—"),
                        str(p.get("status") or "—"),
                        str(p.get("size") or p.get("lot") or "—"),
                    ]
                )
            self._fill(["ID", "SIDE", "STATUS", "SIZE"], data)
            return
        if self.kind == "incidents":
            rows = s.get("incidents") or []
            self.body.setText("NO OPEN INCIDENTS" if not rows else f"{len(rows)} INCIDENTS")
            data = [
                [str(i.get("severity") or "—"), str(i.get("code") or "—"), str(i.get("message") or i), ""]
                for i in rows
                if isinstance(i, dict)
            ]
            self._fill(["SEV", "CODE", "MESSAGE", ""], data)
            return
        if self.kind in ("trading", "strategies", "execution"):
            sup = s.get("supervisor") or {}
            br = s.get("broker") or {}
            tr = raw.get("trading") or {}
            st = raw.get("strategy") or {}
            ex = raw.get("execution") or {}
            self.body.setText(
                f"process_ready={sup.get('process_ready') if sup else 'NO DATA'}\n"
                f"trading_ready={sup.get('trading_ready') if sup else tr.get('readiness') or 'NO DATA'}\n"
                f"broker={br.get('state') if br else 'NO DATA'}\n"
                f"strategy={st.get('status') or 'NO DATA'} {st.get('detail') or ''}\n"
                f"execution={ex.get('status') or 'NO DATA'} {ex.get('detail') or ''}\n"
                f"blockers={sup.get('trading_blockers') if sup else 'NONE'}"
            )
            return
        if self.kind in ("backups", "updates"):
            self.body.setText("NO DATA — CORE has not published this payload.")
            return
        if self.kind == "accounts":
            rows = s.get("clients") or []
            self.body.setText(f"{len(rows)} ACCOUNTS" if rows else "NO ACCOUNTS")
            data = [
                [
                    str(c.get("name") or "—"),
                    "ENABLED" if c.get("access_enabled") else "DISABLED",
                    str(c.get("robot_status") or "—"),
                    str(c.get("panel_lot_size") if c.get("panel_lot_size") is not None else "—"),
                ]
                for c in rows
                if isinstance(c, dict)
            ]
            self._fill(["LOGIN", "ACCESS", "ROBOT", "LOT"], data)
            return
        self.body.setText("NO DATA — this view shows live CORE payload only. Nothing is invented.")

    def _fill(self, headers: list[str], rows: list[list[str]]) -> None:
        self.table.setColumnCount(len(headers))
        self.table.setHorizontalHeaderLabels(headers)
        self.table.setRowCount(0)
        if not rows:
            self.table.insertRow(0)
            self.table.setItem(0, 0, QTableWidgetItem("NO DATA"))
            return
        for row in rows:
            r = self.table.rowCount()
            self.table.insertRow(r)
            for c, v in enumerate(row):
                self.table.setItem(r, c, QTableWidgetItem(v))
