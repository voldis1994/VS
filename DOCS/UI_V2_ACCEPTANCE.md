# UI v2 acceptance

| Gate | Result |
|------|--------|
| NEW i3 UI `SERVER/dashboard-v2` | IMPLEMENTED |
| NEW MSI ADMIN `ADMIN/apps/dashboard-v2` | IMPLEMENTED |
| NEW CLIENT `CLIENT/apps/client-v2` | IMPLEMENTED |
| Old UI not imported by v2 | TESTED (`no-legacy-ui-imports`) |
| Presence heartbeat API | IMPLEMENTED + unit tested |
| i3 autostart | SCRIPT READY (`INSTALL_PANEL_AUTOSTART.sh`) — physical NOT TESTED |
| MSI appears CONNECTED on i3 | CODE PATH READY — physical NOT TESTED |
| MSI DISCONNECTED after timeout | CODE PATH READY — physical NOT TESTED |
| CLIENT different ISP | NOT TESTED |
| Screenshots from real UI | NOT CAPTURED (see screenshots/README) |
| No production mock market/P/L | PASS (code review + empty states) |
| VS-CLIENT-Setup.exe | PARTIAL — folder package via `BUILD_CLIENT_PACKAGE.sh`; Windows .exe packager requires CI |
