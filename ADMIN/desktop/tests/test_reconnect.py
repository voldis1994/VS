from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

from PySide6.QtCore import QCoreApplication

from services.api import ControlApi
from services.live import LiveWorker


class Flaky:
    def __init__(self):
        self.n = 0
        self.fail = False


STATE = Flaky()


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        STATE.n += 1
        if STATE.fail:
            self.send_error(500)
            return
        if self.path == "/health":
            payload = {"service": "VS-CORE", "server_id": "VS-CORE-01"}
        else:
            payload = {
                "role": "server_monitor",
                "server_id": "VS-CORE-01",
                "uptime_human": "1h",
                "api": {"status": "ONLINE"},
                "database": {"status": "ONLINE"},
                "system": {},
                "clients": {"total": 1, "online": 1, "devices": []},
                "market": {"status": "OK", "detail": "ok"},
                "build": {"version": "x"},
            }
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        return


def test_live_worker_reconnect_does_not_fake_connected():
    app = QCoreApplication.instance() or QCoreApplication([])
    httpd = HTTPServer(("127.0.0.1", 0), _Handler)
    port = httpd.server_address[1]
    Thread(target=httpd.serve_forever, daemon=True).start()
    worker = LiveWorker(ControlApi(f"http://127.0.0.1:{port}", timeout=1.0), "LAN")
    seen = []
    worker.snapshot.connect(lambda s: seen.append(s["state"]))
    worker._backoff_ms = 50
    # one success
    snap = worker._tick()
    assert snap["state"] == "CONNECTED"
    STATE.fail = True
    worker._last_ok = __import__("time").time() - 2
    try:
        worker._tick()
        raised = False
    except Exception:
        raised = True
    assert raised
    httpd.shutdown()
    assert worker._last_ok is not None
