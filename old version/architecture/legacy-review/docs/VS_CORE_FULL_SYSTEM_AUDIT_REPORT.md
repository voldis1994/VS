# VS CORE — FULL SYSTEM AUDIT / PRE-PHYSICAL-GATE REVIEW

**Date:** 2026-08-15  
**PR:** [#52](https://github.com/voldis1994/VS/pull/52) (draft — NOT MERGED)  
**Audited tip (pre-fix):** `d6f37aa54f3fb9f6890092e72767e59d0efa074e`  
**Base:** `main` @ `6c3e93c6f29147800d73896a74466e5c4fbb292f`

See git tip after audit fixes for FINAL_SHA.

## Verdict

**SOFTWARE_PASS_WITH_EXTERNAL_BLOCKERS**

- MERGE_READY = NO (draft; alternate openers; recovery gaps; external gates open)
- PHYSICAL_READY = NO
- CAPITAL_DEMO_READY = NO (credentials / real DEMO not run)
- LIVE_READY = NO

## Observed test results (this run)

| Suite | Result |
|-------|--------|
| control-api vitest | 255→257 PASS (after confirm tests) |
| vs-core:verify | 24 PASS / 0 FAIL / 3 EXTERNAL_BLOCKER |
| tsc --noEmit | FAIL→PASS after moneyPathRisk fix |
| Strategy+Exit focused | 65+ PASS |
| Capital real DEMO | EXTERNAL_BLOCKER |
| Physical i3 | EXTERNAL_BLOCKER |
| Historical baseline | EXTERNAL_BLOCKER |

## Minimal fixes during audit

1. `moneyPathRisk.ts` — remove dead OFFLINE/MISSING compare; fail-closed on ERROR; `feed_offline:false` on ok path
2. `confirmCapitalDeal` — reject dealStatus REJECTED/CANCELLED/DELETED/FAILED even when dealId present

## Unfixed HIGH (documented)

- `intentFanout` / admin `POST .../orders` open without Strategy + durable confirm
- Robot session / `close_pending` in-memory only across process restart
- `runCrashRecovery` not wired into control-api live boot
- Default encryption key outside LIVE guard
- Admin settings can toggle LIVE via authenticated API

Full COPY block delivered in agent final message.
