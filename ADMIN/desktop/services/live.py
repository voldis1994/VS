"""Background poll of i3 — never blocks the Qt UI thread. Never fakes CONNECTED."""
from __future__ import annotations

import time
from typing import Any

from PySide6.QtCore import QObject, QThread, Signal, Slot

from app.version import ADMIN_VERSION
from services.api import ApiError, ControlApi, validate_identity


def empty_state() -> dict[str, Any]:
    return {
        "connected": False,
        "state": "DISCONNECTED",
        "connectionPhase": "DISCONNECTED",
        "server_id": "VS-CORE-01",
        "serverId": "VS-CORE-01",
        "transport": "LAN",
        "latency_ms": None,
        "latencyMs": None,
        "last_heartbeat": None,
        "heartbeatAgeSec": None,
        "uptime": None,
        "health": "FAILED",
        "server_version": None,
        "serverVersion": None,
        "adminVersion": ADMIN_VERSION,
        "url": None,
        "error": None,
        "lastError": None,
        "clientsRegistered": 0,
        "clientsOnline": 0,
        "openPositions": None,
        "totalPnlToday": None,
        "cpu": None,
        "ram": None,
        "disk": None,
        "network": None,
        "marketStatus": "NOT_READY",
        "marketDetail": "NO DATA",
        "marketBid": None,
        "marketAsk": None,
        "marketSpread": None,
        "feeds": {},
        "devices": [],
        "presenceClients": [],
        "positions": [],
        "orders": [],
        "trades": [],
        "incidents": [],
        "events": [],
        "supervisor": None,
        "broker": None,
        "raw": None,
        "clients": [],
        "admin": None,
        "ws": "DISCONNECTED",
    }


def _safe(api: ControlApi, path: str) -> Any:
    try:
        return api.get(path)
    except ApiError:
        return None


class LiveWorker(QObject):
    snapshot = Signal(dict)
    finished = Signal()

    def __init__(self, api: ControlApi, transport: str = "LAN"):
        super().__init__()
        self.api = api
        self.transport = transport
        self._stop = False
        self._backoff_ms = 1500
        self._last_ok: float | None = None
        self._ws_ok = False

    def mark_ws(self, ok: bool) -> None:
        self._ws_ok = ok

    @Slot()
    def stop(self) -> None:
        self._stop = True

    @Slot()
    def start(self) -> None:
        self.run()

    def _tick(self) -> dict[str, Any]:
        t0 = time.monotonic()
        health = self.api.health()
        ok, ident = validate_identity(health)
        if not ok:
            raise ApiError(ident)
        hb_at = None
        try:
            self.api.post(
                "/api/v1/presence/heartbeat",
                {
                    "device_id": "VS-ADMIN-01",
                    "display_name": "VS-ADMIN-01",
                    "role": "ADMIN",
                    "transport": self.transport,
                    "app_version": f"vs-admin/{ADMIN_VERSION}",
                },
            )
            hb_at = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
        except ApiError:
            hb_at = None
        snap = self.api.get("/api/v1/server/monitor") or {}
        presence = _safe(self.api, "/api/v1/presence")
        supervisor = _safe(self.api, "/api/v1/system/supervisor")
        broker = _safe(self.api, "/api/v1/broker/health")
        market = _safe(self.api, "/api/v1/market")
        position = _safe(self.api, "/api/v1/position")
        incidents = _safe(self.api, "/api/v1/incidents")
        clients = _safe(self.api, "/api/clients")
        orders = _safe(self.api, "/api/v1/orders")
        trades = _safe(self.api, "/api/v1/trades")
        latency = int((time.monotonic() - t0) * 1000)
        sys = snap.get("system") or {}
        cl = snap.get("clients") or {}
        msnap = snap.get("market") or {}
        net = snap.get("network") or {}
        pos_list = []
        if isinstance(position, dict):
            pos_list = position.get("positions") or position.get("items") or []
        inc_list = []
        if isinstance(incidents, dict):
            inc_list = incidents.get("incidents") or incidents.get("items") or []
        elif isinstance(incidents, list):
            inc_list = incidents
        order_list = []
        if isinstance(orders, dict):
            order_list = orders.get("orders") or orders.get("items") or []
        elif isinstance(orders, list):
            order_list = orders
        trade_list = []
        if isinstance(trades, dict):
            trade_list = trades.get("trades") or trades.get("items") or []
        elif isinstance(trades, list):
            trade_list = trades
        events = []
        for err in snap.get("errors") or []:
            events.append({"type": "error", "message": str(err)})
        if snap.get("last_error"):
            events.append({"type": "error", "message": str(snap.get("last_error"))})
        api_st = (snap.get("api") or {}).get("status")
        db_st = (snap.get("database") or {}).get("status")
        health_label = (
            "HEALTHY"
            if api_st == "ONLINE" and db_st == "ONLINE"
            else ("DEGRADED" if api_st == "ONLINE" else "FAILED")
        )
        sid = str(snap.get("server_id") or health.get("server_id") or "VS-CORE-01")
        ver = (snap.get("build") or {}).get("version") or health.get("VERSION") or snap.get("server_version")
        self._last_ok = time.time()
        self._backoff_ms = 1500
        return {
            **empty_state(),
            "connected": True,
            "state": "CONNECTED",
            "connectionPhase": "CONNECTED",
            "server_id": sid,
            "serverId": sid,
            "transport": self.transport,
            "latency_ms": latency,
            "latencyMs": latency,
            "last_heartbeat": hb_at or "live",
            "heartbeatAgeSec": 0,
            "uptime": snap.get("uptime_human"),
            "health": health_label,
            "server_version": ver,
            "serverVersion": ver,
            "url": self.api.base,
            "error": None,
            "lastError": snap.get("last_error"),
            "clientsRegistered": int(cl.get("total") or 0),
            "clientsOnline": int(cl.get("online") or 0),
            "openPositions": (position.get("open_count") if isinstance(position, dict) else None)
            or (len(pos_list) if pos_list else None),
            "totalPnlToday": position.get("pnl_today") if isinstance(position, dict) else None,
            "cpu": sys.get("cpu_percent"),
            "ram": sys.get("ram_percent"),
            "disk": sys.get("disk_percent"),
            "network": net.get("lan_ip") or net.get("detail") or net.get("status"),
            "marketStatus": str(msnap.get("status") or (market or {}).get("status") or "UNKNOWN"),
            "marketDetail": str(msnap.get("detail") or (market or {}).get("detail") or "NO DATA"),
            "marketBid": (market or {}).get("bid") if isinstance(market, dict) else None,
            "marketAsk": (market or {}).get("ask") if isinstance(market, dict) else None,
            "marketSpread": (market or {}).get("spread") if isinstance(market, dict) else None,
            "feeds": snap.get("feeds") or {},
            "devices": cl.get("devices") or [],
            "presenceClients": (presence or {}).get("clients") or snap.get("presence_clients") or [],
            "positions": pos_list if isinstance(pos_list, list) else [],
            "orders": order_list if isinstance(order_list, list) else [],
            "trades": trade_list if isinstance(trade_list, list) else [],
            "incidents": inc_list if isinstance(inc_list, list) else [],
            "events": events,
            "supervisor": supervisor,
            "broker": {"state": str((broker or {}).get("state") or (broker or {}).get("status") or "UNKNOWN")}
            if broker
            else None,
            "raw": snap,
            "clients": clients if isinstance(clients, list) else [],
            "admin": snap.get("admin"),
            "ws": "CONNECTED" if self._ws_ok else "POLLING",
        }

    @Slot()
    def run(self) -> None:
        state = empty_state()
        state["transport"] = self.transport
        state["url"] = self.api.base
        while not self._stop:
            try:
                state = self._tick()
            except Exception as e:
                now = time.time()
                age = None if self._last_ok is None else max(0, int(now - self._last_ok))
                phase = "DISCONNECTED"
                health = "FAILED"
                if age is not None and age < 15:
                    phase, health = "RECONNECTING", "DEGRADED"
                elif age is not None and age < 45:
                    phase, health = "RECONNECTING", "DEGRADED"
                state = {
                    **state,
                    "connected": False,
                    "state": phase,
                    "connectionPhase": phase,
                    "health": health,
                    "heartbeatAgeSec": age,
                    "error": str(e),
                    "lastError": str(e),
                    "ws": "DISCONNECTED",
                }
                self._backoff_ms = min(max(self._backoff_ms, 1500) * 2, 12000)
            self.snapshot.emit(state)
            slept = 0
            step = 50
            while slept < self._backoff_ms and not self._stop:
                QThread.msleep(step)
                slept += step
        self.finished.emit()


def start_live_thread(api: ControlApi, transport: str) -> tuple[QThread, LiveWorker]:
    thread = QThread()
    worker = LiveWorker(api, transport)
    worker.moveToThread(thread)
    thread.started.connect(worker.start)
    worker.finished.connect(thread.quit)
    return thread, worker
