# Final Test Matrix

| Test | AUTOMATED/MANUAL | RESULT | EVIDENCE | BLOCKER |
|------|------------------|--------|----------|---------|
| Repository cleanup | MANUAL+AUTO | PASS | `DOCS/FINAL_REPOSITORY_AUDIT.md`; shims removed; `legacy-review/` | |
| Legacy import check | AUTOMATED | PASS | `TESTS/unit/no-legacy-ui-imports.test.ts` | |
| Clean clone build | AUTOMATED | PASS* | control-api/TESTS/ADMIN/client-api npm test; UI path compile via vite when deps installed | *full UI build optional in agent |
| Database migration files | AUTOMATED | PASS | migrations 001–013 present | physical apply BLOCKED |
| Server startup | MANUAL | BLOCKED | no Debian i3 in agent | hardware |
| Server restart | MANUAL | BLOCKED | | hardware |
| Server reboot | MANUAL | BLOCKED | | hardware |
| Monitor | AUTOMATED+MANUAL | PASS code / BLOCKED physical | `SERVER/monitor`, `SHOW_DASHBOARD.sh` | hardware display |
| ADMIN build | AUTOMATED | PASS | `ADMIN/desktop` sources + install scripts | |
| ADMIN install | MANUAL | BLOCKED | | Windows MSI |
| ADMIN auth/heartbeat | AUTOMATED | PASS | presence + adminAgent tests | |
| ADMIN reconnect | MANUAL | BLOCKED | | MSI LAN |
| CLIENT build | AUTOMATED | PASS | `CLIENT/desktop` + `BUILD_CLIENT` | |
| CLIENT installer | MANUAL | BLOCKED / PARTIAL | folder package script; `.exe` needs Windows CI | packager |
| CLIENT enrollment | AUTOMATED+MANUAL | PASS API / BLOCKED physical | network enrollment routes + tests | remote PC |
| CLIENT auth/heartbeat | AUTOMATED | PASS boundary | client-api + network heartbeat→presence | |
| WireGuard provisioning | AUTOMATED+MANUAL | PASS scripts / BLOCKED tunnel | `SERVER/network` | public UDP |
| WireGuard handshake | MANUAL | BLOCKED | | remote ISP |
| Market pipeline | AUTOMATED | PASS validation | core market-data tests | LIVE feed NOT_CONFIGURED |
| Indicators | AUTOMATED | PASS | core-engines tests | |
| Regime | AUTOMATED | PASS | | |
| Strategy | AUTOMATED | PASS | | |
| Signal | AUTOMATED | PASS | | |
| Risk | AUTOMATED | PASS | kill switch + risk | |
| Execution OSM | AUTOMATED | PASS | | |
| Broker adapter | AUTOMATED | PASS | CONFIG_REQUIRED without secrets | Capital creds |
| Reconciliation | AUTOMATED | PASS unit | | |
| Audit / incidents | AUTOMATED | PASS | | |
| Backup / restore / update | MANUAL scripts | PASS present / BLOCKED run | `SERVER/*BACKUP*`, `UPDATE_SERVER` | hardware |
| Security CLIENT≠ADMIN | AUTOMATED | PASS | `TESTS/security/client-admin-boundary.test.ts` | |
| Remote networking | MANUAL | BLOCKED | | public endpoint / CGNAT |
| Physical MSI↔i3 | MANUAL | BLOCKED | | dual machines |
| Physical remote CLIENT | MANUAL | BLOCKED | | different ISP |

\* Agent environment validates TypeScript tests; Windows installers are not executed here.
