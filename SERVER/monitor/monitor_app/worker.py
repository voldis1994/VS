from __future__ import annotations

import json
import os
import time
import urllib.request
from typing import Any

from PySide6.QtCore import QObject, QThread, Signal, Slot

BASE = (os.environ.get("VS_MONITOR_API_URL") or "http://127.0.0.1:3000").rstrip("/")


def fetch_json(path: str, timeout: float = 4.0) -> Any:
    url = BASE + path
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))


class MonitorWorker(QObject):
    snapshot = Signal(dict)
    finished = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._stop = False

    @Slot()
    def stop(self) -> None:
        self._stop = True

    @Slot()
    def start(self) -> None:
        while not self._stop:
            try:
                health = fetch_json("/health") or {}
                try:
                    snap = fetch_json("/api/v1/server/monitor/console") or {}
                except Exception:
                    snap = fetch_json("/api/v1/server/monitor") or {}
                if not isinstance(snap, dict):
                    snap = {}
                snap["_health"] = health
                snap["_connected"] = str(health.get("service") or "") == "VS-CORE"
                snap["_error"] = None
                snap["_ts"] = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
            except Exception as e:
                snap = {
                    "_connected": False,
                    "_error": str(e),
                    "_ts": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
                    "server_id": "VS-CORE-01",
                }
            self.snapshot.emit(snap)
            slept = 0
            while slept < 1000 and not self._stop:
                QThread.msleep(50)
                slept += 50
        self.finished.emit()
