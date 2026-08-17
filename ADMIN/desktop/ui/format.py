"""Display helpers — never invent production values."""

from __future__ import annotations

from typing import Any


def nd(value: Any, fallback: str = "NO DATA") -> str:
    if value is None or value == "":
        return fallback
    return str(value)


def pct(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return "NO DATA"
    return f"{value:.0f}%"


def cell(obj: Any, *keys: str) -> Any:
    cur = obj
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def as_list(value: Any, *keys: str) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in keys:
            item = value.get(key)
            if isinstance(item, list):
                return item
    return []


def conn_color(state: str) -> str:
    return {
        "CONNECTED": "#2ef28a",
        "LIVE": "#2ef28a",
        "RECONNECTING": "#e6b84d",
        "DISCONNECTED": "#ff5a5a",
        "OFFLINE": "#ff5a5a",
    }.get(state.upper(), "#8B93A7")
