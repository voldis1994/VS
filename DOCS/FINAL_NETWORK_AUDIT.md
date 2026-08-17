# Network audit

| Port | Role | Bind | Who | Internet | Notes |
|------|------|------|-----|----------|-------|
| 3000 | VS private Control / ADMIN API | i3 LAN / WG | MSI Admin.exe, i3 monitor | NO | Identity `VS-CORE` / `VS-CORE-01` |
| 443 | VS public CLIENT HTTPS | i3 / gateway | Internet clients | YES | `/etc/vs/client-url` |
| 5432 | PostgreSQL | localhost | CORE | NO | |
| 6379 | Redis | localhost | CORE | NO | |
| 5188 | removed | — | — | — | Old ADMIN web UI archived |
| 5173 | removed | — | — | — | Old Vite ADMIN archived |

ADMIN desktop application does not listen on any TCP port.
