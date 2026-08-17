from __future__ import annotations

from PySide6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from models.table_model import DictTableModel
from widgets.metric_bar import MetricBar


def _txt(v) -> str:
    if v is None or v == "":
        return "NO DATA"
    return str(v)


class DashboardPage(QWidget):
    def __init__(self):
        super().__init__()
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(12)

        self.cards = {}
        grid = QGridLayout()
        labels = [
            ("health", "SERVER HEALTH"),
            ("uptime", "UPTIME"),
            ("clients", "CLIENTS"),
            ("accounts", "ACCOUNTS"),
            ("positions", "OPEN POSITIONS"),
            ("pnl", "TODAY P/L"),
        ]
        for i, (key, title) in enumerate(labels):
            card = QFrame()
            card.setObjectName("Card")
            lay = QVBoxLayout(card)
            lab = QLabel(title)
            lab.setObjectName("CardLabel")
            val = QLabel("—")
            val.setObjectName("CardValue")
            lay.addWidget(lab)
            lay.addWidget(val)
            self.cards[key] = val
            grid.addWidget(card, i // 3, i % 3)
        root.addLayout(grid)

        mid = QHBoxLayout()
        mframe = QFrame()
        mframe.setObjectName("Card")
        ml = QVBoxLayout(mframe)
        h = QLabel("MARKET OVERVIEW")
        h.setObjectName("Section")
        self.marketBody = QLabel("NO DATA")
        self.marketBody.setWordWrap(True)
        ml.addWidget(h)
        ml.addWidget(self.marketBody)
        mid.addWidget(mframe, 2)

        rframe = QFrame()
        rframe.setObjectName("Card")
        rl = QVBoxLayout(rframe)
        rh = QLabel("SYSTEM RESOURCES")
        rh.setObjectName("Section")
        self.cpu = MetricBar("CPU")
        self.ram = MetricBar("RAM")
        self.ssd = MetricBar("SSD")
        self.net = QLabel("NETWORK  NO DATA")
        self.net.setObjectName("muted")
        rl.addWidget(rh)
        rl.addWidget(self.cpu)
        rl.addWidget(self.ram)
        rl.addWidget(self.ssd)
        rl.addWidget(self.net)
        mid.addWidget(rframe, 1)
        root.addLayout(mid)

        self.feeds = QLabel("FEED HEALTH — NO DATA")
        root.addWidget(self.feeds)

        tables = QHBoxLayout()
        self.client_model = DictTableModel(
            ["CLIENT", "STATUS", "TRANSPORT", "LAST SEEN"],
            ["name", "status", "transport", "seen"],
        )
        self.client_table = QTableView()
        self.client_table.setModel(self.client_model)
        self.client_table.horizontalHeader().setStretchLastSection(True)
        self.client_table.verticalHeader().setVisible(False)
        self.order_model = DictTableModel(
            ["ORDER", "SIDE", "STATUS", "SIZE"],
            ["id", "side", "status", "size"],
        )
        self.order_table = QTableView()
        self.order_table.setModel(self.order_model)
        self.order_table.horizontalHeader().setStretchLastSection(True)
        self.order_table.verticalHeader().setVisible(False)
        left = QVBoxLayout()
        clh = QLabel("CLIENT STATUS")
        clh.setObjectName("Section")
        left.addWidget(clh)
        left.addWidget(self.client_table)
        right = QVBoxLayout()
        oh = QLabel("RECENT ORDERS")
        oh.setObjectName("Section")
        right.addWidget(oh)
        right.addWidget(self.order_table)
        tables.addLayout(left, 1)
        tables.addLayout(right, 1)
        root.addLayout(tables, 1)

        self.incidents = QLabel("INCIDENTS — NO DATA")
        self.events = QLabel("RECENT EVENTS — NO DATA")
        root.addWidget(self.incidents)
        root.addWidget(self.events)

    def apply(self, s: dict) -> None:
        self.cards["health"].setText(_txt(s.get("health")))
        self.cards["health"].setProperty("ok", "true" if s.get("health") == "HEALTHY" else "false")
        self.cards["uptime"].setText(_txt(s.get("uptime")))
        self.cards["clients"].setText(f"{s.get('clientsOnline') or 0} / {s.get('clientsRegistered') or 0}")
        n_acc = len(s.get("clients") or [])
        self.cards["accounts"].setText(str(n_acc) if n_acc else "NO DATA")
        pos = s.get("openPositions")
        self.cards["positions"].setText("NO DATA" if pos is None else str(pos))
        pnl = s.get("totalPnlToday")
        self.cards["pnl"].setText("NO DATA" if pnl is None else str(pnl))
        bid, ask, sp = s.get("marketBid"), s.get("marketAsk"), s.get("marketSpread")
        quote = "NO DATA" if bid is None and ask is None else f"bid {bid}  ask {ask}  spread {sp}"
        self.marketBody.setText(
            f"{s.get('marketStatus') or 'UNKNOWN'}\n{s.get('marketDetail') or 'NO DATA'}\n{quote}"
        )
        self.cpu.set_value(s.get("cpu") if isinstance(s.get("cpu"), (int, float)) else None)
        self.ram.set_value(s.get("ram") if isinstance(s.get("ram"), (int, float)) else None)
        self.ssd.set_value(s.get("disk") if isinstance(s.get("disk"), (int, float)) else None)
        self.net.setText(f"NETWORK  {_txt(s.get('network'))}")
        feeds = s.get("feeds") or {}
        if not feeds:
            self.feeds.setText("FEED HEALTH — NO DATA")
        else:
            parts = []
            for name, cell in feeds.items():
                if isinstance(cell, dict):
                    parts.append(f"{name}: {cell.get('status') or 'NO DATA'}")
                else:
                    parts.append(f"{name}: {cell}")
            self.feeds.setText("FEED HEALTH  " + "   ".join(parts))

        rows = []
        for c in s.get("presenceClients") or []:
            rows.append(
                {
                    "name": c.get("display_name") or c.get("device_id") or "—",
                    "status": c.get("status") or "—",
                    "transport": "LAN",
                    "seen": "heartbeat" if c.get("app_connected") else "—",
                }
            )
        for d in s.get("devices") or []:
            rows.append(
                {
                    "name": d.get("device_id") or "—",
                    "status": d.get("connection_state") or d.get("status") or "—",
                    "transport": d.get("transport") or "—",
                    "seen": d.get("last_seen_human") or "—",
                }
            )
        self.client_model.set_rows(rows)
        orders = []
        for o in (s.get("orders") or [])[:20]:
            if not isinstance(o, dict):
                continue
            orders.append(
                {
                    "id": o.get("id") or o.get("order_id") or "—",
                    "side": o.get("side") or "—",
                    "status": o.get("status") or "—",
                    "size": o.get("size") or o.get("lot") or "—",
                }
            )
        self.order_model.set_rows(orders)
        incs = s.get("incidents") or []
        if not incs:
            self.incidents.setText("INCIDENTS — NO OPEN INCIDENTS")
        else:
            self.incidents.setText(
                "INCIDENTS  " + " | ".join(str(i.get("message") or i.get("code") or i) for i in incs[:5] if isinstance(i, dict) or True)
            )
        events = s.get("events") or []
        if not events:
            self.events.setText("RECENT EVENTS — NO DATA")
        else:
            bits = []
            for ev in events[:6]:
                if isinstance(ev, dict):
                    bits.append(str(ev.get("message") or ev.get("type") or ev))
                else:
                    bits.append(str(ev))
            self.events.setText("RECENT EVENTS  " + " | ".join(bits))
