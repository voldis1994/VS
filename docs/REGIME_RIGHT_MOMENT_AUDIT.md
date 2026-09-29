# Regime at the right market moment — full audit

**Datums:** 2026-09-29  
**PR:** #647–#652 (range-only / no-sell-break-fade / playbook split / right-moment)  
**Proof suite:** `apps/control-api/src/services/regimeMomentFullAudit.proof.test.ts`  
**Scenario suite:** `apps/control-api/src/services/regimeRightMoment.test.ts`

## Verdict

**PASS** — classify → stabilize → story → playbook → entry tagad sakrīt ar tirgus brīdi:

| Brīdis | Klasifikācija | Live (stabilize) | Stāsts | Playbook lane | Entry |
|--------|---------------|------------------|--------|---------------|-------|
| A Sell-break shelf | `BREAKOUT_DOWN` | uzreiz (strong) | `BREAK_DOWN` | `BREAKOUT` | SELL BREAKOUT |
| B Pirmais bounce pēc dump | `FAILED_BREAKOUT_*` / bounce | — | bounce / exhaust | FAILED/PULLBACK | **WAIT** |
| C Šaurs mid-zone chop (±1.5pt) | `RANGE` | `RANGE` | `RANGE_CHOP` | `RANGE_FADE` | nav TREND chase |
| D Quiet grind UP | `TREND_UP` | uzreiz (strong) | directional | `TREND_PULLBACK` | FADE bloķēts |
| E Bounce + 1m DOWN resume | `TREND_DOWN` | `TREND_DOWN` | `BREAK_DOWN`/sell | `TREND_PULLBACK` | FADE bloķēts |
| F BREAKOUT ar īsu dwell | `BREAKOUT_*` | uzreiz | — | `BREAKOUT` | — |

## Live ceļš

```
10s OHLC
  → classifyRegime          (30m ZONE_BARS + local shelf pierce)
  → stabilizeRegime         (dwell/confirm; strong switch skips lag)
  → readMarketStory         (1m trekFirm ≥ 1.5× minPath)
  → pickEntryPlaybook       (BREAKOUT | TREND_PULLBACK | RANGE_FADE | …)
  → decideEntryWithStructure
  → robotDesk order
```

RANGE fade **nekad** nebloķē TREND/BREAKOUT — `effectiveEntryRegime` = playbook regime.

## Labojumi šajā auditā (kas bija salauzts)

### 1. Dwell lag (CHOP → TREND)
**Pirms:** `live=RANGE` kamēr `classify=TREND_UP` — gaidīja CONFIRM_BARS.  
**Tagad:** `isStrongSwitch(RANGE|COMPRESSION → TREND_*|PULLBACK_*)` = true → flips tūlīt (#652).

### 2. False EXHAUST uz thin chop
**Pirms:** ±1.5pt sine + `HH_HL` + tip pie “griestiem” → `EXHAUST_HI` → fake TREND.  
**Tagad:** visas directional / recent-color klausules prasa `trekFirm` (#652).

### 3. EXHAUST + flat HTF ≠ TREND
**Pirms:** `EXHAUST_HI` ar flat Capital → playbook `TREND_UP`.  
**Tagad:** `RANGE_FADE` (#652).

### 4. RANGE SELL uz sell-break
**Pirms:** live RANGE + shelf pierce → FADE SELL.  
**Tagad:** local `BREAKOUT_DOWN` + BREAKOUT lane; FADE bloķēts (#650/#651).

### 5. Bounce knife
**Pirms:** SELL uz pirmā zaļā bounce.  
**Tagad:** WAIT līdz 1m DOWN resume (#650).

### 6. RANGE only when range
**Pirms:** 10s chop / false RANGE bloķēja citus.  
**Tagad:** Capital HTF UP/DOWN → `TREND_PULLBACK`; RANGE_FADE tikai flat/mixed + chop (#647/#651).

## Playbook līgums (who looks at what)

| Lane | Kad | Setup atļauti | Setup aizliegti |
|------|-----|---------------|-----------------|
| `BREAKOUT` | live BREAKOUT_* **vai** stāsts BREAK_* | BREAKOUT, CONTINUATION | **FADE** |
| `TREND_PULLBACK` | live TREND/PULLBACK **vai** Capital HTF UP/DOWN **vai** RALLY/SELLOFF/DIP/BOUNCE | PULLBACK, CONTINUATION | **FADE** |
| `RANGE_FADE` | HTF flat/mixed **un** chop/EXHAUST bez HTF | FADE | BREAKOUT chase |
| `REVERSAL` | live `REVERSAL_CANDIDATE` | REVERSAL, CONTINUATION | FADE |
| `LIVE` | EXPANSION / FAILED_BREAKOUT_* | per-regime | — |

## Kā pārbaudīt

```bash
cd apps/control-api
npx vitest run src/services/regimeMomentFullAudit.proof.test.ts src/services/regimeRightMoment.test.ts
```

Saistītie: `entryPlaybook.test.ts`, `regimes.test.ts` (strong switch), `marketStory.test.ts`, `structureEntry.test.ts` (effectiveEntryRegime), `traderMind.test.ts` (bounce WAIT).

## Atlikušie / ārpus šī audita

- Pre-existing: daži `SEEDING` / raw `TREND_DOWN` SETUP NOW testi `structureEntry.test.ts` (nav #652 regresija).
- Soft/HardInv + genome auto-tune — atsevišķs ceļš (`autoCalibrate`), nav šajā regime moment auditā.
