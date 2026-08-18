"""VS ADMIN native desktop — HTTP client for i3 Control API. No trading logic."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from app.version import ADMIN_VERSION, EXPECTED_SERVICE, SERVER_ID

EXPECTED_SERVER_ID = SERVER_ID


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def parse_health(raw: str | bytes | dict[str, Any]) -> dict[str, Any]:
    if isinstance(raw, dict):
        body = raw
    else:
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        body = json.loads(text)
    if not isinstance(body, dict):
        raise ApiError("health is not an object")
    return body


def validate_identity(body: dict[str, Any], expected_id: str = EXPECTED_SERVER_ID) -> tuple[bool, str]:
    service = str(body.get("service") or "")
    server_id = str(body.get("server_id") or body.get("name") or "")
    if service != EXPECTED_SERVICE:
        return False, f"not VS-CORE (got service={service or 'undefined'})"
    if not server_id:
        return False, "missing server_id"
    if expected_id and server_id != expected_id:
        return False, f"expected {expected_id} got {server_id}"
    return True, server_id


def _read_kv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, v = t.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def default_server_url() -> str:
    for key in ("VS_SERVER_URL", "VS_API_URL", "API_BASE"):
        raw = (os.environ.get(key) or "").strip()
        if raw:
            return raw.rstrip("/")
    here = Path(__file__).resolve()
    admin_root = here.parents[2]  # ADMIN/
    envf = _read_kv(admin_root / "config" / "control-panel.env")
    if envf.get("VS_SERVER_URL"):
        return envf["VS_SERVER_URL"].rstrip("/")
    ip_file = admin_root / "config" / "SERVER_IP.txt"
    if ip_file.is_file():
        ip = ip_file.read_text(encoding="utf-8", errors="replace").strip().splitlines()[0].strip()
        if ip:
            return f"http://{ip}:3000"
    return "http://127.0.0.1:3000"


def default_admin_token() -> str:
    return (
        os.environ.get("API_ADMIN_TOKEN")
        or os.environ.get("VS_ADMIN_TOKEN")
        or ""
    ).strip()


def default_transport() -> str:
    raw = (os.environ.get("VS_ADMIN_TRANSPORT") or "LAN").strip().upper()
    if raw in ("WG", "WIREGUARD"):
        return "WIREGUARD"
    return "LAN"


class ControlApi:
    def __init__(self, base_url: str, token: str = "", timeout: float = 6.0):
        self.base = (base_url or "").rstrip("/")
        self.token = token or ""
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            h["x-admin-token"] = self.token
        return h

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        if not self.base:
            raise ApiError("NO_API_BASE")
        url = self.base + path
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method, headers=self._headers())
        wait = self.timeout if timeout is None else timeout
        try:
            with urllib.request.urlopen(req, timeout=wait) as res:
                raw = res.read()
                if not raw:
                    return None
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                raw_err = e.read().decode("utf-8", errors="replace")
                parsed = json.loads(raw_err) if raw_err else {}
                if isinstance(parsed, dict):
                    detail = str(parsed.get("error") or parsed.get("message") or raw_err)
                else:
                    detail = raw_err
            except Exception:
                detail = ""
            raise ApiError(f"HTTP {e.code} {path}" + (f": {detail}" if detail else ""), e.code) from e
        except Exception as e:
            raise ApiError(str(e)) from e

    def get(self, path: str) -> Any:
        return self.request("GET", path)

    def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        return self.request("POST", path, body or {})

    def put(self, path: str, body: dict[str, Any] | None = None) -> Any:
        return self.request("PUT", path, body or {})

    def health(self) -> dict[str, Any]:
        return parse_health(self.get("/health"))
