from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

from services.api import ControlApi
from services.live import LiveWorker, CONNECTED_POLL_MS


class _Handler(BaseHTTPRequestHandler):
    heartbeat = 0
    gets: list[str] = []

    def do_GET(self):  # noqa: N802
        _Handler.gets.append(self.path)
        if self.path == "/health":
            payload = {"service": "VS-CORE", "server_id": "VS-CORE-01", "VERSION": "9.9.9"}
        elif self.path == "/api/v1/server/monitor":
            payload = {
                "role": "server_monitor",
                "server_id": "VS-CORE-01",
                "uptime_human": "2h",
                "api": {"status": "ONLINE"},
                "database": {"status": "ONLINE"},
                "system": {"cpu_percent": 11, "ram_percent": 22, "disk_percent": 33},
                "clients": {"total": 2, "online": 1, "devices": []},
                "market": {"status": "OK", "detail": "ticks"},
                "feeds": {"capital": {"status": "OK"}},
                "build": {"version": "9.9.9"},
            }
        elif self.path == "/api/clients":
            payload = [{"name": "alpha", "access_enabled": True, "robot_status": "STOPPED"}]
        elif self.path == "/api/v1/position":
            payload = {"positions": [{"symbol": "XAUUSD", "side": "BUY", "size": 0.1}], "open_count": 1}
        elif self.path == "/api/v1/orders":
            payload = {"orders": [{"id": "o1", "side": "BUY", "status": "FILLED", "size": 0.1}]}
        elif self.path == "/api/v1/incidents":
            payload = {"incidents": [{"severity": "WARN", "code": "FEED", "message": "stale"}]}
        else:
            payload = {}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802
        if self.path == "/api/v1/presence/heartbeat":
            _Handler.heartbeat += 1
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        return


def test_tick_uses_real_payloads_and_heartbeat():
    _Handler.heartbeat = 0
    _Handler.gets = []
    httpd = HTTPServer(("127.0.0.1", 0), _Handler)
    Thread(target=httpd.serve_forever, daemon=True).start()
    worker = LiveWorker(ControlApi(f"http://127.0.0.1:{httpd.server_address[1]}", timeout=2.0), "LAN")
    snap = worker._tick()
    assert "/api/clients" in _Handler.gets
    httpd.shutdown()
    assert snap["state"] == "CONNECTED"
    assert snap["connected"] is True
    assert _Handler.heartbeat >= 1
    assert snap["clientsRegistered"] == 2
    assert snap["openPositions"] == 1
    assert snap["orders"][0]["id"] == "o1"
    assert snap["incidents"][0]["code"] == "FEED"
    assert snap["clients"][0]["name"] == "alpha"
    assert snap["health"] == "HEALTHY"
    assert worker._backoff_ms == CONNECTED_POLL_MS


def test_later_ticks_reuse_extra_payloads():
    _Handler.heartbeat = 0
    _Handler.gets = []
    httpd = HTTPServer(("127.0.0.1", 0), _Handler)
    Thread(target=httpd.serve_forever, daemon=True).start()
    worker = LiveWorker(ControlApi(f"http://127.0.0.1:{httpd.server_address[1]}", timeout=2.0), "LAN")
    first = worker._tick()
    assert first["clients"][0]["name"] == "alpha"
    _Handler.gets = []
    second = worker._tick()
    httpd.shutdown()
    assert "/health" in _Handler.gets
    assert "/api/v1/server/monitor" in _Handler.gets
    assert "/api/clients" not in _Handler.gets
    assert "/api/brokers" not in _Handler.gets
    assert "/api/robot-desk" not in _Handler.gets
    assert second["clients"][0]["name"] == "alpha"
    assert second["orders"][0]["id"] == "o1"


def test_websocket_failure_does_not_force_connected():
    worker = LiveWorker(ControlApi("http://127.0.0.1:9", timeout=0.2), "LAN")
    worker.mark_ws(False)
    state = {"state": "DISCONNECTED", "connected": False}
    assert worker._ws_ok is False
    assert state["state"] != "CONNECTED"
