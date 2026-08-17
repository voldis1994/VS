from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

from services.api import ControlApi, parse_health, validate_identity


def test_parse_health_and_identity():
    body = parse_health('{"service":"VS-CORE","server_id":"VS-CORE-01"}')
    ok, ident = validate_identity(body)
    assert ok is True
    assert ident == "VS-CORE-01"


def test_reject_wrong_service():
    ok, msg = validate_identity({"service": "express", "server_id": "VS-CORE-01"})
    assert ok is False
    assert "VS-CORE" in msg


def test_reject_missing_server_id():
    ok, msg = validate_identity({"service": "VS-CORE"})
    assert ok is False
    assert "server_id" in msg


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            payload = {"service": "VS-CORE", "server_id": "VS-CORE-01", "status": "ok"}
        elif self.path == "/api/v1/server/monitor":
            payload = {
                "role": "server_monitor",
                "server_id": "VS-CORE-01",
                "uptime_human": "1h",
                "api": {"status": "ONLINE"},
                "database": {"status": "ONLINE"},
                "system": {"cpu_percent": 10, "ram_percent": 20, "disk_percent": 30},
                "clients": {"total": 0, "online": 0, "devices": []},
                "market": {"status": "OK", "detail": "feed"},
                "feeds": {},
                "build": {"version": "test"},
            }
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        return


def test_control_api_health_roundtrip():
    httpd = HTTPServer(("127.0.0.1", 0), _Handler)
    port = httpd.server_address[1]
    t = Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    api = ControlApi(f"http://127.0.0.1:{port}")
    body = api.health()
    ok, ident = validate_identity(body)
    assert ok and ident == "VS-CORE-01"
    httpd.shutdown()
