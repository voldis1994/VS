from __future__ import annotations

from monitor_app.tui import render


def test_tui_render_offline_does_not_say_live_ready():
    text = render({}, {}, "connection refused")
    assert "VS CORE" in text
    assert "VS-CORE-01" in text
    assert "OFFLINE" in text
    assert "ERROR" in text
    assert "LIVE READY" not in text or "OFFLINE" in text


def test_tui_render_live_uses_payload():
    snap = {
        "uptime_human": "3h",
        "server_version": "9.9.9",
        "build": {"version": "9.9.9", "build_commit": "abc"},
        "system": {"cpu_percent": 10, "ram_percent": 20, "disk_percent": 30},
        "database": {"status": "ONLINE", "detail": "ok"},
        "redis": {"status": "ONLINE", "detail": "ok"},
        "market": {"status": "OK", "state": "OPEN", "detail": "ticks"},
        "feeds": {"capital": {"status": "OK"}},
        "trading": {"readiness": "READY", "detail": "ok"},
        "strategy": {"status": "OK"},
        "execution": {"status": "OK"},
        "admin": {"connected": True, "source_ip": "192.168.0.20", "transport": "LAN"},
        "clients": {"total": 2, "online": 1, "devices": []},
    }
    text = render(snap, {"service": "VS-CORE", "server_id": "VS-CORE-01"}, None)
    assert "LIVE READY" in text
    assert "3h" in text
    assert "MSI CONNECTED" in text
    assert "192.168.0.20" in text
