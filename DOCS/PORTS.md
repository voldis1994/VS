# Ports

| Port | Role | Bind | Who |
|------|------|------|-----|
| **3000** | VS private Control / ADMIN API | i3 LAN + trusted WG | MSI `VS Admin.exe` |
| **443** | VS public CLIENT HTTPS | i3 / gateway | Internet browsers |
| **5432** | PostgreSQL | internal | VS CORE only |
| **6379** | Redis | internal | VS CORE only |
| **51820/udp** | WireGuard | WAN→LAN | remote CLIENT devices |

Removed from production:

| Port | Why |
|------|-----|
| **5188** | Old ADMIN localhost web UI — archived |
| **5173** | Old Vite ADMIN — archived |

ADMIN desktop (`VS Admin.exe`) does not listen on any TCP port.

CLIENT is the only web UI. It does not require an install and does not use ADMIN ports.
