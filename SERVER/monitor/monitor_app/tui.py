"""Quality TUI fallback when i3 has no graphical session."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from typing import Any

BASE = (os.environ.get("VS_MONITOR_API_URL") or "http://127.0.0.1:3000").rstrip("/")
GREEN = "\033[32m"
AMBER = "\033[33m"
RED = "\033[31m"
DIM = "\033[90m"
BOLD = "\033[1m"
RESET = "\033[0m"
CYAN = "\033[36m"


def _color_ok() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def c(text: str, code: str) -> str:
    if not _color_ok():
        return text
    return f"{code}{text}{RESET}"


def nd(v: Any, fallback: str = "NO DATA") -> str:
    if v is None or v == "":
        return fallback
    return str(v)


def cell(obj: Any, *keys: str) -> Any:
    cur = obj
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def fetch(path: str, timeout: float = 4.0) -> Any:
    url = BASE + path
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
        return json.loads(raw.decode("utf-8")) if raw else None


def st(status: Any) -> str:
    s = str(status or "").upper()
    if s in ("ONLINE", "HEALTHY", "OK", "LIVE", "READY", "CONNECTED"):
        return c(nd(status), GREEN)
    if s in ("OFFLINE", "FAILED", "ERROR", "DISCONNECTED"):
        return c(nd(status), RED)
    if not s:
        return c("NO DATA", DIM)
    return c(nd(status), AMBER)


def box(title: str, lines: list[str], width: int = 34) -> list[str]:
    inner = width - 2
    out = [c("┌" + f" {title} ".ljust(inner, "─") + "┐", DIM)]
    for line in lines:
        raw = line[:inner]
        out.append("│" + raw.ljust(inner) + "│")
    out.append(c("└" + "─" * inner + "┘", DIM))
    return out


def join_cols(cols: list[list[str]], gap: int = 2) -> str:
    height = max(len(col) for col in cols)
    padded = [col + [""] * (height - len(col)) for col in cols]
    rows = []
    for i in range(height):
        rows.append((" " * gap).join(padded[j][i] for j in range(len(padded))))
    return "\n".join(rows)


def render(snap: dict, health: dict, err: str | None) -> str:
    connected = str(health.get("service") or "") == "VS-CORE"
    live = c("● LIVE READY", GREEN + BOLD) if connected else c("● OFFLINE", RED + BOLD)
    ts = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    header = [
        c("VS CORE", GREEN + BOLD) + "   " + c("VS-CORE-01", CYAN) + "   " + live,
        f"{c('UPTIME', DIM)} {nd(snap.get('uptime_human'))}    {c('UTC', DIM)} {ts}    "
        f"{c('VERSION', DIM)} {nd(snap.get('server_version') or cell(snap, 'build', 'version'))}    "
        f"{c('BUILD', DIM)} {nd(cell(snap, 'build', 'build_commit'))}",
        "",
    ]
    sys = snap.get("system") or {}
    system = box(
        "SYSTEM",
        [
            f"CPU   {nd(sys.get('cpu_percent'))}%",
            f"RAM   {nd(sys.get('ram_percent'))}%",
            f"SSD   {nd(sys.get('disk_percent'))}%",
            f"NET   {nd(cell(snap, 'network', 'lan_ip') or cell(snap, 'network', 'status'))}",
        ],
    )
    database = box(
        "DATABASE",
        [
            f"PostgreSQL  {st(cell(snap, 'database', 'status'))}",
            nd(cell(snap, "database", "detail")),
        ],
    )
    cache = box(
        "CACHE",
        [
            f"Redis  {st(cell(snap, 'redis', 'status'))}",
            nd(cell(snap, "redis", "detail")),
        ],
    )
    feeds = snap.get("feeds") or {}
    feed_txt = " ".join(
        f"{k}:{nd(v.get('status') if isinstance(v, dict) else v)}" for k, v in feeds.items()
    ) or "NO DATA"
    m = snap.get("market") or {}
    market = box(
        "MARKET",
        [
            f"{st(m.get('status'))}  {nd(m.get('state'))}",
            nd(m.get("detail")),
            f"feeds {feed_txt}",
            "10s OHLC from CORE",
        ],
        42,
    )
    tr = snap.get("trading") or {}
    stg = snap.get("strategy") or {}
    ex = snap.get("execution") or {}
    trading = box(
        "TRADING",
        [
            f"strategies  {st(stg.get('status'))}",
            f"execution   {st(ex.get('status'))}",
            f"ready       {st(tr.get('readiness'))}",
            nd(tr.get("detail")),
        ],
        42,
    )
    admin = snap.get("admin") or {}
    admin_box = box(
        "ADMIN",
        [
            "MSI CONNECTED" if admin.get("connected") else "MSI DISCONNECTED",
            f"IP {nd(admin.get('source_ip'))}",
            f"transport {nd(admin.get('transport'))}",
            f"heartbeat {nd(admin.get('last_seen_human') or admin.get('last_seen'))}",
        ],
    )
    cl = snap.get("clients") or {}
    clients = box(
        "CLIENTS",
        [
            f"registered {nd(cl.get('total'), '0')}",
            f"online     {nd(cl.get('online'), '0')}",
            f"devices    {len(cl.get('devices') or [])}",
            f"paused     {nd(cl.get('offline'), '0')}",
        ],
    )
    errs = list(snap.get("errors") or [])
    if snap.get("last_error"):
        errs = [snap.get("last_error")] + errs
    incidents = box("INCIDENTS", [str(x)[:40] for x in (errs[:4] or ["NONE"])])
    events = snap.get("presence_clients") or []
    ev_lines = [
        f"{e.get('display_name') or e.get('device_id')} {e.get('status')}"
        for e in events[:4]
        if isinstance(e, dict)
    ] or ["NO DATA"]
    ev_box = box("RECENT EVENTS", [str(x)[:40] for x in ev_lines])
    footer = ""
    if err:
        footer = "\n" + c("ERROR  " + err, RED)
    else:
        footer = "\n" + c("read-only local monitor · Ctrl+C stops monitor only", DIM)
    return "\n".join(
        [
            *header,
            join_cols([system, database, cache]),
            "",
            join_cols([market, trading]),
            "",
            join_cols([admin_box, clients, incidents, ev_box], 1),
            footer,
        ]
    )


def run_tui() -> int:
    print("VS SERVER MONITOR  TUI  " + BASE, file=sys.stderr)
    try:
        while True:
            err = None
            health: dict = {}
            snap: dict = {}
            try:
                health = fetch("/health") or {}
                try:
                    snap = fetch("/api/v1/server/monitor/console") or fetch("/api/v1/server/monitor") or {}
                except Exception:
                    snap = fetch("/api/v1/server/monitor") or {}
                if not isinstance(snap, dict):
                    snap = {}
            except Exception as e:
                err = str(e)
            if sys.stdout.isatty():
                sys.stdout.write("\033[H\033[2J")
            sys.stdout.write(render(snap, health, err) + "\n")
            sys.stdout.flush()
            time.sleep(1)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(run_tui())
