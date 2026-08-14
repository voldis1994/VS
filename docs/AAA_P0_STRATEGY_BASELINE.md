# VS AAA — P0 STRATEGY BASELINE REPORT

Generated: 2026-08-14T19:30:00Z (agent environment)
Operator local TZ assumed: Europe/Riga (EEST, UTC+3) from prior runtime context.

## VERDICT

**HISTORICAL STRATEGY NOT PROVEN**

This cloud agent workspace does **not** contain the operator machine’s runtime artefacts:

* no `C:\VS-main\.vs-build-sha`
* no `vs-launcher.log` from the Windows host
* no Postgres dumps / decision ticks from that session
* no process/startup logs from 2026-08-13 16:00 local
* cloud-agent transcript API returned **0** accessible agents for this principal/filter

Therefore the exact SHA that was **executing** on the operator PC at yesterday 16:00 local **cannot** be proven here.

Git history alone proves what was on `origin/main` at wall-clock times — **not** what ZIP/VS.exe had already applied on disk.

---

## REQUESTED FIELDS

| Field | Value |
| --- | --- |
| STRATEGY_COMMIT | **NOT PROVEN** (runtime) |
| STRATEGY_CONFIG | **NOT PROVEN** (no config snapshot from host) |
| STRATEGY_FILES | **NOT PROVEN** (see candidates below) |
| START_TIME | requested: 2026-08-13 16:00 local (Europe/Riga) = 2026-08-13 13:00 UTC |
| END_TIME | requested: morning 2026-08-14 local (≈ before 09:00 EEST / 06:00 UTC) |

---

## GIT-CORRELATED CANDIDATES (NOT RUNTIME PROOF)

These are `origin/main` tips at wall-clock moments. Operator must confirm with `.vs-build-sha` / launcher log.

| Wall clock | UTC | `main` tip | Notes |
| --- | --- | --- | --- |
| 2026-08-13 16:00 Riga | 13:00 | `5e25bca` | “Drive robot entries from 10-second OHLC, not tick FLAT” |
| 2026-08-13 19:00 Riga | 16:00 | `65b5d30` | public feeds merge |
| 2026-08-13 19:21 Riga | 16:21 | `76146e8` | Capital-anchor OHLC + capital-lag guard (“Fix live trades”) |
| 2026-08-13 20:43 Riga | 17:43 | `e0e479a` | SL cushion 0.25%→**0.20% of price** |
| 2026-08-14 ~09:00 Riga | 06:00 | still `e0e479a` | no further strategy commits overnight |

Conversation claims of “worked around 16:00” are **ambiguous** (16:00 local vs 16:00 UTC). Without host SHA, neither is proven.

### Candidate strategy file set (at `e0e479a` — end of overnight window)

```
apps/control-api/src/services/robotDesk.ts
apps/control-api/src/services/entryFromRegime.ts
apps/control-api/src/services/regimes.ts
apps/control-api/src/services/tenSecondOhlc.ts
apps/control-api/src/services/robotReader.ts
apps/control-api/src/services/publicInternetFeeds.ts
apps/control-api/src/services/staleQuoteGuard.ts
apps/control-api/src/services/exitManage.ts
apps/control-api/src/services/capitalCom.ts
apps/control-api/src/services/intentFanout.ts
```

SL at that tip: **0.20% of price** (`39fd006` / merge `e0e479a`).

---

## OPERATOR CONFIRMATION REQUIRED

On the Windows machine that traded yesterday, run:

```powershell
cd C:\VS-main
Get-Content .vs-build-sha -ErrorAction SilentlyContinue
Get-Content .vs-launcher-id -ErrorAction SilentlyContinue
Get-Content vs-launcher.log -Tail 80 -ErrorAction SilentlyContinue
```

Paste SHA → that becomes **STRATEGY_COMMIT** proof.

Until then: do **not** claim historical strategy restore is proven.

---

## DRIFT SINCE CANDIDATE `e0e479a` → current `main`

Large algorithmic drift in `entryFromRegime.ts`, `robotDesk.ts` (with-trend locks, COMPRESSION soft entry, just_closed fix, Yahoo basis filter, UI redesign). Current `main` is **not** identical to overnight baseline.
