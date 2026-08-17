# Final network audit

| PORT | SERVICE | BIND | ACCESS | PUBLIC? | PURPOSE |
|---|---|---|---|---|---|
| 3000 | VS Control / ADMIN API | `0.0.0.0` on i3, firewall LAN+WG | MSI LAN, localhost, WireGuard | NO | Private administration + identity `/health` |
| 443 | VS CLIENT gateway | `0.0.0.0` | Internet clients | YES | HTTPS (or HTTP until `/etc/vs/tls` exists) client web + `/api/client*` |
| 5188 | VS ADMIN local UI | `127.0.0.1` on MSI | MSI browser only | NO | Built ADMIN frontend |
| 5432 | PostgreSQL | `127.0.0.1` | i3 only | NO | Database |
| 6379 | Redis | `127.0.0.1` | i3 only | NO | Cache / state |
| 51820/udp | WireGuard | i3 public UDP | Remote devices | YES | Optional remote tunnel |

5173 is not a production port.

CLIENT stable URL is `/etc/vs/client-url`. Updates do not rewrite that file.
