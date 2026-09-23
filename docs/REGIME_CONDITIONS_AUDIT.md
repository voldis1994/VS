# Trade regimes — nosacījumi + izpildāmības audits

**Datums:** 2026-09-17  
**Live ceļš (Capital robot):** `10s OHLC` → `classifyRegime` (`regimes.ts`) → `regimeAllowedForEntry` (`deskCalibration.ts`) → `decideEntryWithStructure` (`structureEntry.ts` = 10s recipe + 30m zona + 1m no tiem pašiem 10s + `readMarketStory`) → `robotDesk` order.

**Svarīgi:** Regime = **tirgus stāvokļa klasifikators**, nevis pats entry. Entry notiek tikai, ja (1) režīms ir ieslēgts kalibrācijā, (2) `decideEntry…` atgriež signālu, (3) 10s svece ir “moving”.

**2026-09-23 audita labojumi (net≠trek klases kļūdas):**
- `readMarketStory` + `minuteTrendBias` lieto **trek** (hi−lo), ne open→close net (V-bounce selloff ≠ “troksnis” / FLAT).
- `BREAKOUT_*` prasa pierce zone hi/lo (mid 0.55 fake → reject).
- `EXPANSION` — impuls + pareizā puse.
- `COMPRESSION` / `TRANSITION` — wait-only (entry null).

---

## Kopīgie sliekšņi (10s bārs)

No `tenSecondOhlc.ts` / `regimes.ts` / `entryFromRegime.ts` (procentos no mid cenas):

| Mērījums | Formula / slieksnis | Gold ~2000 ≈ |
|----------|---------------------|--------------|
| `bodyPct` | `(close−open)/mid` | 0.015% ≈ **0.30 pt** |
| `rangePct` | `(high−low)/mid` | 0.025% ≈ **0.50 pt** |
| Moving bar | `\|body\|≥0.015%` **vai** `range≥0.025%` | |
| Dip / rally (entry) | `body ≤ −0.015%` / `≥ +0.015%` | |
| Persistence | pēdējo 6 bāru ķermeņu zīme (−1/0/+1), vidējais | |
| Compression range | `lastRange < avg×0.55` **un** `<0.022%` | &lt; **~0.44 pt** |
| Expansion range | `lastRange > avg×1.45` **un** `≥0.025%` | |

Logs: `prior` = pēdējie 7 bāri pirms pēdējā; `hi`/`lo` no prior high/low.

### Klasifikācijas prioritāte (pirmais match uzvar)

1. FAILED_BREAKOUT_*  
2. COMPRESSION  
3. BREAKOUT_*  
4. EXPANSION  
5. PULLBACK_*  
6. TREND_*  
7. REVERSAL_CANDIDATE  
8. RANGE  
9. TRANSITION  
10. UNKNOWN  

---

## Režīmu tabula (Capital live)

| Režīms | Klasificējas? | Default ON? | Entry? | Verdict |
|--------|---------------|-------------|--------|---------|
| UNKNOWN | jā (&lt;2 bari / fallthrough) | nē (bloķēts) | **nē** | **DEAD** |
| RANGE | jā | jā | fade dip→BUY / rally→SELL | **LIVE** |
| TREND_UP | jā | jā | tikai dip→BUY (PULLBACK) | **LIVE** |
| TREND_DOWN | jā | jā | tikai rally→SELL | **LIVE** |
| PULLBACK_UPTREND | jā | jā | rally→BUY (CONTINUATION) | **LIVE** |
| PULLBACK_DOWNTREND | jā | jā | dip→SELL | **LIVE** |
| COMPRESSION | jā | **jā (maldinoši)** | **vienmēr null (wait-only)** | **DEAD / wait-only** |
| EXPANSION | jā | jā | follow body + half / impulse (structure) | **LIVE** |
| BREAKOUT_UP | jā | jā | follow up **only at/through hi** | **LIVE** |
| BREAKOUT_DOWN | jā | jā | follow down **only at/through lo** | **LIVE** |
| FAILED_BREAKOUT_UP | jā (TS) | jā | fade SELL uz dip | **LIVE** (TS) |
| FAILED_BREAKOUT_DOWN | jā (TS) | jā | fade BUY uz rally | **LIVE** (TS) |
| REVERSAL_CANDIDATE | jā (rets) | jā | dip→SELL / rally→BUY | **PARTIAL** (rets) |
| TRANSITION | jā | nē* | **vienmēr null (wait-only)** | **DEAD / UI trap** |

\*UI “All on” var ieslēgt TRANSITION; entry joprojām nekad.

---

## Detalizēti nosacījumi

### UNKNOWN — DEAD
- **Detect:** `&lt;2` bari, vai nekas cits nesader.
- **Entry:** hard-block `regimeAllowedForEntry`; `decideEntry` → null.

### RANGE — LIVE
- **Detect:** `close` starp prior `hi`/`lo`; nav stiprāka režīma.
- **Entry:** moving + dip → BUY FADE; moving + rally → SELL FADE.

### TREND_UP — LIVE
- **Detect:** `persistence > 0.35` un `lastVel > 0.00005`.
- **Entry:** moving + **dip** → BUY PULLBACK (neieiet trendā uz rally).

### TREND_DOWN — LIVE
- Spoguļis: persistence &lt; −0.35, vel &lt; −0.00005; entry tikai rally→SELL.

### PULLBACK_UPTREND — LIVE
- **Detect:** `previous === TREND_UP` un `lastVel < −0.00008` un `persistence > 0.15`.
- **Entry:** moving + rally → BUY CONTINUATION.
- **Piezīme:** pārņem daudz “pretējās” sveces no REVERSAL, kamēr persistence vēl augsta.

### PULLBACK_DOWNTREND — LIVE
- Spoguļis: iepriekš TREND_DOWN, vel &gt; +0.00008, persistence &lt; −0.15; entry dip→SELL.

### COMPRESSION — DEAD (wait-only)
- **Detect:** `compressed && inRange` (ļoti šaurs 10s range).
- **Entry:** **apzināti null** — “wait for expansion/breakout” (`decideEntryFrom10sRegime` + `structureGate`).
- **Problēma:** joprojām `TRADABLE_DEFAULT` / UI toggle — ieslēgšana **neko neietekmē**.

### EXPANSION — LIVE
- **Detect:** expanding, bet nav tīra breakout virziena.
- **Entry:** moving + rally→BUY / dip→SELL; structure prasa impuls + pareizo pusi.

### BREAKOUT_UP / BREAKOUT_DOWN — LIVE
- **Detect:** expanding + close ārpus prior hi/lo + virziens (trend vai lastVel).
- **Entry:** follow; structure prasa **pierce** zone hi/lo (mid-zone fake breakout → reject).

### FAILED_BREAKOUT_UP / DOWN — LIVE (Capital TS)
- **Detect:** iepriekšējais BREAKOUT_* + atpakaļ `inRange` + pretējs lastVel.
- **Entry:** fade (SELL pēc failed up; BUY pēc failed down).
- **C++ `RegimeEngine`:** enum ir, bet `classify()` **neatgriež** — docs saka “Reserved”. Live Capital robot lieto **TS**, ne C++.

### REVERSAL_CANDIDATE — PARTIAL (rets)
- **Detect:** iepriekš TREND_UP + ļoti spēcīgs down bar (`lastVel < −0.0012`, ~0.12%, range expanding, nav breakoutDown) — vai spoguļis.
- **Entry:** moving + dip→SELL / rally→BUY REVERSAL.
- **Kāpēc “sajūta, ka nestrādā”:** PULLBACK noteikumi ir **augstāk** prioritātē un bieži “apēd” pretējos barus, kamēr persistence &gt; 0.15.

### TRANSITION — DEAD / UI trap
- **Detect:** bija nosaukts režīms (ne UNKNOWN/RANGE), bet nav skaidra nākamā.
- **Entry:** null (wait-only). Nav default ON, bet UI “All on” to ieslēdz bez jēgas.

---

## Kalibrācijas / UI maldinājumi

1. **COMPRESSION** default ON, bet nekad neieiet.  
2. **TRANSITION** “All on” → ON, bet nekad neieiet.  
3. **UNKNOWN** nav toggle (pareizi bloķēts).  
4. Vecais `docs/REGIMES.md` apraksta galvenokārt **C++** RegimeEngine; Capital desk izmanto **TS** `regimes.ts` (FAILED_BREAKOUT tur ir live).

---

## C++ SetupEngine (nav Capital robot entry)

C++ setupi tikai no TREND_* / PULLBACK_*. RANGE / EXPANSION / BREAKOUT / FAILED / COMPRESSION / REVERSAL / TRANSITION → **nav C++ setup**. Tas **nebloķē** Capital `robotDesk` (TS entry).

---

## Secinājumi — “daļa reāli nav izpildāma”

| # | Režīms | Statuss |
|---|--------|---------|
| 1 | UNKNOWN | Nav izpildāms (pareizi) |
| 2 | COMPRESSION | Klasificējas, toggle ON, **entry 0** |
| 3 | TRANSITION | Klasificējas, var ieslēgt UI, **entry 0** |
| 4 | REVERSAL_CANDIDATE | Teorētiski live, praksē **rets** (PULLBACK priority) |
| 5 | FAILED_BREAKOUT_* | Live uz Capital TS; dead C++ klasifikatorā |

**Pilnībā LIVE ar sveces nosacījumiem:** RANGE, TREND_*, PULLBACK_*, EXPANSION, BREAKOUT_*, FAILED_BREAKOUT_* (TS).

---

## Avoti

- `apps/control-api/src/services/regimes.ts` — `classifyRegime`  
- `apps/control-api/src/services/entryFromRegime.ts` — `decideEntryFrom10sRegime`  
- `apps/control-api/src/services/deskCalibration.ts` — `regimeAllowedForEntry`, `TRADABLE_DEFAULT`  
- `apps/control-api/src/services/tenSecondOhlc.ts` — `isMoving10s`, body/range  
- `apps/control-api/src/services/robotDesk.ts` — entry gate ~1255  
- `apps/dashboard/src/components/DeskControlPanel.tsx` — UI regime chips / All on  
