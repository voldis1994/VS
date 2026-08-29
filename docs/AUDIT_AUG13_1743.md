# Audits: tirdzniecības sistēma pie commit `e0e479a` (2026-08-13 17:43)

> Snapshot: branch `cursor/open-aug13-1743-e0e479a-9254` · hash `e0e479a1623e7e40beb87f50c85e8274791f5451`  
> Šis dokuments apraksta **tikai to, kas pastāvēja šajā commit**. Vēlākas izmaiņas nav pieņemtas kā daļa no šī snapshot.

---

## 1. Commit pin

| Lauka | Vērtība |
|-------|---------|
| **Hash** | `e0e479a1623e7e40beb87f50c85e8274791f5451` |
| **Datums** | 2026-08-13 17:43:37 +0000 |
| **Tips** | Merge commit |
| **Message** | `Merge branch 'cursor/tighter-safety-sl-75a0': slightly tighter safety SL` |
| **Parents** | `76146e8` (base) + `39fd006` (feature: Tighten safety SL cushion slightly 0.25% → 0.20%) |
| **Skartie faili** | `capitalCom.ts`, `intentFanout.ts`, `robotDesk.ts`, `tradingQuality.test.ts` |

Faktiskā loģikas izmaiņa ir feature commitā `39fd006` (*Tighten safety SL cushion slightly (0.25% → 0.20%)*). Merge `e0e479a` to ienes `main`-līnijā.

---

## 2. Verdict / kopsavilkums

Šajā snapshot **live Capital tirdzniecība** darbojas galvenokārt caur **Node `control-api`** (`robotDesk` + `intentFanout` + `exitManage`), nevis caur C++ `ExitEngine` / `EntryEngine` hot-path dokumentāciju. Brokerī tiek likts **SAFETY SL spilvens (~0.20%)**; peļņas/zaudējumu “Best Outcome” aizvēršanu veic programmatūras `decideBestOutcomeExit` ~2s ciklā.

**17:43 izmaiņa** ir mērena: SAFETY spilvens no **0.25% → 0.20%**, broker min reizinātājs **3× → 2.5×**, spreada reizinātājs **10× → 8×**. Mērķis — mazliet tuvāks SL, joprojām **ne** dealing-rules minimums.

**Galvenais risks šajā kodā:** ja Capital noraida SL, `robotDesk.enterTrade` **tomēr atver pozīciju bez SL**. `STOP_TOO_WIDE` **šajā commit nav** (meklēšana bez rezultātiem). Multi-feed entry gate ir **soft advisory** (`allowEntryFromFeeds` vienmēr `ok: true`).

---

## 3. Kas šis snapshot IR (spējas)

### 3.1 Divas paralēlas arhitektūras

| Slānis | Loma pie šī commit |
|--------|---------------------|
| **C++ market-core** (`libs/*`, `apps/market-core`) | Pilna pipeline: feeds → features → regime → setup → evidence → EntryEngine → intents. Dokumentēts `ENTRY_ENGINE.md` / `EXIT_ENGINE.md` / `REGIMES.md`. |
| **Node control-api live Capital** | Admin Robot Desk + Client Panel fan-out: 10s OHLC, Node regime classifier, regime entry, Best Outcome manage, Capital REST. |

Live pozīciju **manage/exit** robotam ir Node `exitManage.ts`, ne `libs/exit-engine`. C++ policy (`peak_retention_threshold: 0.5` utt.) **nesakrīt** ar Node Best Outcome sliekšņiem.

### 3.2 Spējas (Node live)

- Viena atvērta pozīcija uz epic (`ONE TRADE ONLY`)
- Ieeja no **10s aizvērtas sveces** + **14 režīmu** (`decideEntryFrom10sRegime`)
- Multi-feed OHLC (Capital + public near Capital) ar Capital enkuru
- Stale Capital quote guard pret fresher refs (pirms 17:43: `76146e8` / `4963904`)
- Broker SAFETY SL cushion pie ieejas
- Best Outcome manage: ThesisFailure, HardInvalidation, PeakProtection, Target, BestOutcome harvest, TimeDecay
- Client Panel: `ENTRY_READY` intent → `intentFanout` → manage-only robots (`entry_enabled: false`)
- Tirgus slēgts → park (90s poll, bez manage/entry)

### 3.3 Ko šis snapshot NAV

- Nav `STOP_TOO_WIDE` (vai līdzīga) gate
- Nav hard multi-feed entry block (tikai piezīme)
- Nav vienots SL/BO parametru avots starp C++ YAML un Node
- `docs/TRADING_SL_SETUP_FIX.md` joprojām raksta **0.25% / 3×** — novecojis pret kodu

---

## 4. Arhitektūras pārskats

```
[Capital quote ~2s] ──► robotCycle (robotDesk)
        │
        ├─ multi-feed (throttle 4s) → pickOhlcMid → 10s OHLC
        ├─ classifyRegime (closed 10s bars)
        ├─ sync open positions (broker truth)
        │
        ├─ OPEN? ──► decideBestOutcomeExit ──► closeCapitalPosition
        │              (Best Outcome)              │
        │                                          └─ Capital SAFETY SL (broker hard)
        │
        └─ FLAT + entry_enabled?
               ├─ cooldown 20s after close
               ├─ just_closed 10s? → decideEntryFrom10sRegime
               ├─ 1m late-move gate
               ├─ staleQuoteGuard
               └─ enterTrade (+ SAFETY SL)

[market-core / pipeline HTTP]
        └─ ENTRY_READY → intentFanout → createCapitalPosition (+ cushion SL)
                              └─ attachManageOnlyRobot (exits only)
```

**Ieeja:** Robot Desk (lokālais smadzenes) **vai** central pipeline fan-out.  
**Izeja:** Best Outcome (soft, Node) **un** Capital SAFETY SL (hard broker).  
**Režīmi:** Node `regimes.ts` no 10s OHLC; pipeline var `notePipelineRegime`.  
**Feeds:** `robotReader` + `publicInternetFeeds`; public tālu no Capital tiek ignorēts (~0.8% anchor).

---

## 5. Parametru tabula (exact)

### 5.1 SAFETY SL cushion (17:43 mērķis)

| Nosaukums | Vērtība | Kur |
|-----------|---------|-----|
| `% cushion` | **0.20%** (`abs * 0.002`) | `robotDesk.ts:313`, `capitalCom.ts:953`, `robotDesk.ts:336` |
| Broker min × | **2.5** | `robotDesk.ts:320,341`, `capitalCom.ts:955` |
| Spread × | **8** | `robotDesk.ts:320`, `capitalCom.ts:955` |
| Floor (≥1000) | `0.5` | `robotDesk.ts:318`, `capitalCom.ts:954` |
| Floor (≥100) | `0.25` | turpat |
| Floor (≥10) | `0.05` | turpat |
| Floor (≥1 / else) | `0.0005` / `0.00005` | `robotDesk` (detalizētāks); `capitalCom` floor bez `<1` zara |
| Loosen steps (robot) | `[1, 1.15, 1.35, 1.6, 2.0]` | `robotDesk.ts:639` |
| Distance path min floor after loosen | joprojām **`minPts * 3`** | `robotDesk.ts:648` ⚠️ nesaskaņa ar 2.5× |

Pirms 17:43: `0.0025` (0.25%), `brokerMin * 3`, `spr * 10`.

### 5.2 Best Outcome (`exitManage.ts`)

| Nosaukums | Vērtība | Rinda |
|-----------|---------|-------|
| TP (Target) | `max(absEntry * 0.0035, 0.35)` ≈ **0.35%** | `:65` |
| Soft SL (HardInvalidation) | `max(absEntry * 0.0022, 0.22)` ≈ **0.22%** | `:66` |
| MFE floor (peak / harvest) | `max(absEntry * 0.0012, 0.12)` ≈ **0.12%** | `:67` |
| PeakProtection retention | **`< 0.3`** (un MFE ≥ floor) | `:73` |
| BestOutcome harvest retention | **`< 0.4`**, `fav > 0`, MFE ≥ floor | `:87` |
| TimeDecay | **> 480_000 ms (8 min)**, `fav ≥ 0`, MFE ≥ floor×0.5 | `:95` |
| ThesisFailure | pretējs trend/breakout/pullback/failed regime | `:19–46` |

Salīdzinājumam C++ / docs: `peak_retention_threshold: 0.5` (`config/exit-policy.yaml`, `EXIT_ENGINE.md`) — **nav** tas pats, ko lieto live Node BO.

### 5.3 Entry / OHLC / feeds / cadence

| Nosaukums | Vērtība | Kur |
|-----------|---------|-----|
| Active robot cadence | **2000 ms** | `robotDesk.ts:129` (komentārs “6s” ir novecojis `:1360`) |
| Closed market cadence | **90_000 ms** | `:130` |
| Closed tick throttle | **5 min** | `:131` |
| Multi-feed refresh | **≥ 4_000 ms** | `:950` |
| SECOND seed throttle | **≥ 8_000 ms** | `:1091` |
| Post-close entry cooldown | **20_000 ms** | `:1076` |
| 10s “moving” body | **≥ 0.00015** (0.015%) | `tenSecondOhlc.ts:42`, `entryFromRegime.ts:17–21` |
| 10s “moving” range | **≥ 0.00025** | `tenSecondOhlc.ts:42` |
| Dip / rally body | **±0.00015** | `entryFromRegime.ts:17–21` |
| 1m late-move threshold | `max(mid * 0.0012, 0.05)` ≈ **0.12%** | `capitalCom.ts:1026` |
| Stale quote min rel | **0.0012** (0.12%) | `staleQuoteGuard.ts:19` |
| Public near-Capital anchor | **0.8%** (`ANCHOR_MAX_REL`) | `robotReader.ts:788` |
| Fuse STRONG span | **< 0.05%** | `publicInternetFeeds.ts:150` |
| Fuse diverge (mixed) | **> 1.5%** | `:146` |
| OHLC blend MULTI/LOCAL | **35% multi / 65% local** | `robotReader.ts:999` |
| Regime bar window | last **8** of up to **24** | `regimes.ts:105,124` |

### 5.4 Regime → entry mapping (Node)

| Regime | Direction / setup | Piezīme |
|--------|-------------------|---------|
| UNKNOWN, TRANSITION, COMPRESSION | `null` (WAIT) | |
| TREND_UP | BUY PULLBACK (dip) | |
| TREND_DOWN | SELL PULLBACK (rally) | |
| PULLBACK_UPTREND | BUY CONTINUATION (rally) | |
| PULLBACK_DOWNTREND | SELL CONTINUATION (dip) | |
| BREAKOUT_UP/DOWN | follow BREAKOUT | |
| FAILED_BREAKOUT_* | FADE | |
| REVERSAL_CANDIDATE | REVERSAL by body | |
| EXPANSION | follow body | |
| RANGE | FADE dip/rally | |

Avots: `entryFromRegime.ts:32–100`.

---

## 6. Entry pipeline (soļi)

### 6.A Robot Desk (`robotCycle` → `enterTrade`)

1. **Session** — Capital kredenciāli, `acquireCapitalSession`.
2. **Quote** — `fetchCapitalMarketQuote`; fail → ERROR.
3. **Market status** — ja nav `TRADEABLE`/`OPEN` (tukšs status = atļaut) → park 90s.
4. **Multi-feed** (≤4s) — `readMultiFeedPrice`; `pickOhlcMid` → OHLC mid.
5. **10s OHLC** — `updateTenSecondOhlc`; uz `just_closed` → `observeClosedBars` / regime.
6. **Broker sync** — ja ir open uz epic → MANAGE; ja lokāli open bet broker flat → FLAT.
7. **Ja open** → exit path (skat. §7), **nav** entry.
8. **Ja `!entry_enabled`** → MANAGE-ONLY wait (pipeline intents).
9. **Cooldowntdown** 20s pēc close.
10. **SECOND seed** tikai ja multi-feed **ne** owns OHLC.
11. **Feed note** — `allowEntryFromFeeds` (šajā kodā **nekad nebloķē** entry; tikai tick).
12. **Signal** — tikai uz `just_closed` + `decideEntryFrom10sRegime`.
13. **1m late-move** — `isLateMoveOnOneMinute` → SKIP.
14. **Stale Capital** — `detectStaleQuoteAdverse` vs public near + 10s close/forming → SKIP.
15. **`enterTrade`**:
    - vēlreiz list positions (ONE TRADE);
    - SAFETY caur `stopDistance` (POINTS) ar loosen, tad `stopLevel`;
    - **ja visi SL mēģinājumi fail** → **order bez SL** (`robotDesk.ts:732–746`);
    - state → MANAGE, persist positions (best-effort).

### 6.B Client / pipeline (`intentFanout`)

1. `decision` jābūt **`ENTRY_READY`** (citādi throw).
2. Idempotency claim (`pipeline_execution_claims` / `pipeline_intent_dedupe`).
3. Ownership + Capital session.
4. Skip ja jau open uz epic.
5. 1m late-move gate.
6. `computeSafetyCushionStopLevel` → **viens** `createCapitalPosition` ar `stopLevel` (bez loosen loop; bez “entry without SL” fallback — ja SL fail, trade **ne** atveras).
7. `attachManageOnlyRobot` (`entry_enabled: false`).

**Atšķirība:** fanout **nav** stale-quote guard un **nav** stopDistance/loosen; robot desk **var** atvērt bez SL.

---

## 7. Exit / Best Outcome pipeline

### 7.1 Broker hard path — Capital SAFETY SL

- Uzlikts pie ieejas kā cushion (ne min dealing rule).
- Broker aizver, ja cena sasniedz stop — **neatkarīgi** no Node cikla.
- Soft BO HardInvalidation (~0.22%) ir **nedaudz platāks** nekā SAFETY (~0.20%), tāpēc tipiski broker SL var atrasties tuvāk; soft SL ir rezerves, ja broker SL nav / atšķiras.

### 7.2 Soft path — `decideBestOutcomeExit` (katrā manage tick)

Secība kodā (`exitManage.ts:53–102`):

1. Nav side/entry → hold  
2. **ThesisFailure** (regime pretējs side) → exit  
3. **HardInvalidation** (`fav ≤ -sl`) → exit  
4. **PeakProtection** (MFE ≥ floor, retention `< 0.3`) → exit  
5. **Target** (`fav ≥ tp` ~0.35%) → exit  
6. **BestOutcome harvest** (MFE ≥ floor, `fav > 0`, retention `< 0.4`) → exit  
7. **TimeDecay** (>8 min, non-neg UPL, daļējs MFE) → exit  
8. Citādi hold  

`robotDesk` manage (`:1035–1057`): ja `decision.exit` → `exitTrade` → `closeCapitalPosition`.

MFE/`peak_retention` atjauno `updateExcursion` (`robotDesk.ts:367–376`): `peak_retention = fav / mfe`.

---

## 8. Risk gates / blockers (kas PASTĀVĒJA TAD)

| Gate | Efekts | Kur |
|------|--------|-----|
| Market not TRADEABLE/OPEN | Park; no manage/entry | `robotDesk.ts:927–942` |
| Trading OFF | Read only | `:1024–1032` |
| ONE TRADE / broker already open | No new entry; adopt MANAGE | `:592–611`, fanout `:264–278` |
| Position sync fail | No new entry “if unsure” | `:1000–1007` |
| `entry_enabled: false` | No local brain | `:1061–1071` |
| 20s post-close cooldown | Delay re-entry | `:1076–1085` |
| Wait for 10s bar close | No mid-bar entry | `:1137–1159` |
| Regime unsuitable / UNKNOWN… | No signal | `entryFromRegime` |
| 1m late-move | SKIP | robot + fanout |
| Stale Capital vs fresher refs (≥0.12% adverse) | SKIP (robot only) | `staleQuoteGuard` |
| Multi-feed DIVERGENT | **Nē hard block** — note only | `allowEntryFromFeeds` always `ok` |
| Rate limit 429 | Slow cadence 20s | `robotDesk.ts:900` |
| EXIT without dealId | Stay MANAGE, no new entry | `:511–520` |
| Non-ENTRY_READY intent | Reject | `intentFanout.ts:86–88` |
| Idempotency duplicate | Skip re-exec | fanout |

### Kas **nav** šajā commit

- **`STOP_TOO_WIDE`** — nav simbolu / stringu repo šajā snapshot.
- Hard public-feed freeze (apzināti noņemts / padarīts advisory — skat. `allowEntryFromFeeds` komentāru `:1028–1029`).

---

## 9. Zināmie riski / vājās vietas (grounded THIS code)

1. **Entry without SL fallback** (`robotDesk.ts:732–746`) — pēc rejected SL joprojām `createCapitalPosition` bez stop. Kritisks riska logs.
2. **`minPts * 3` loosen floor** (`:648`) — nesaskaņa ar jaunajiem 2.5× cushion aprēķiniem; distance path joprojām var “pielīmēties” pie 3× min.
3. **Dubulta SL / BO semantika** — SAFETY 0.20% vs soft HardInvalidation 0.22% vs C++ docs PeakProtection 0.5; operatori viegli sajauc.
4. **`docs/TRADING_SL_SETUP_FIX.md` novecojis** — joprojām 0.25% / 3× pēc 17:43.
5. **Fanout ≠ Robot SL resilience** — fanout viens `stopLevel` mēģinājums; nav stale guard; entry_price no `referencePrice` (var būt `null`).
6. **`allowEntryFromFeeds` nekad nebloķē** — DIVERGENT Capital peers netiek hard-stopped (`robotReader.ts:1054–1057`).
7. **ThesisFailure agresīvs** — jebkurš pretējs named regime (arī zaļā pozīcijā) → tūlītēja close; RANGE/COMPRESSION/UNKNOWN neizraisa.
8. **Cadence komentārs vs kods** — “6s TRADEABLE” vs `ACTIVE_CADENCE_MS = 2000`.
9. **C++ vs Node exit** — live Capital manage izmanto Node BO; `EXIT_ENGINE.md` / `exit-policy.yaml` apraksta citu sistēmu.
10. **`decideFromClosed10s`** (`tenSecondOhlc.ts`) — vecāks fade (dip→BUY / rally→SELL) joprojām eksistē; live path izmanto `decideEntryFrom10sRegime` (labāk), bet dead/parallel API paliek.
11. **Instrument `id || 0`** pie positions insert (`robotDesk.ts:827`) — iespējama slikta DB rinda ja market nav katalogā.

---

## 10. Diff: 17:43 izmaiņa (0.25 → 0.20) un ietekme

### Kas mainījās

| Parametrs | Pirms (`76146e8`) | Pēc (`e0e479a` / `39fd006`) |
|-----------|-------------------|------------------------------|
| `% cushion` | 0.25% (`0.0025`) | **0.20% (`0.002`)** |
| Broker min multiplier | 3× | **2.5×** |
| Spread multiplier | 10× | **8×** |
| Komentāri / testi | 0.25% | atjaunināti uz 0.20%; tests arī `mid - level < mid*0.0025 + 0.5` |

Faili: `capitalCom.computeSafetyCushionStopLevel`, `robotDesk.safetyStopLevel` / `safetyStopDistancePts`, `intentFanout` komentārs, `tradingQuality.test.ts`.

### Ietekme

- Broker SAFETY stop **tuvāks** entry (~20% ciešāks procentuālais spilvens; arī zemāki floor-reizinātāji pret min/spread).
- Joprojām **virs** tipiska dealing-rules minimuma (mērķis paliek “cushion, not min”).
- Best Outcome TP/soft-SL/peak **nemainījās** šajā commit — tikai SAFETY cushion.
- Risks: biežāki broker stop-out uz trokšņa, ja 0.20% ir pārāk tuvu instrumenta tipiskajam swing; pretēji — mazāks max adverse pirms hard stop.
- **Neaizvāc** “entry without SL” un **neievieš** `STOP_TOO_WIDE`.

Piemērs (Gold mid=2000, minStop=0.5, spread=0.4):  
`dist = max(4.0, 1.25, 3.2, 0.5) = 4.0` → BUY stop ≈ bid−4.  
Pirms: `max(5.0, 1.5, 4.0, 0.5) = 5.0`.

---

## 11. Failu karte (kritiskie servisi)

### Node live path

| Fails | Loma |
|-------|------|
| `/workspace/apps/control-api/src/services/robotDesk.ts` | Robot lifecycle, cycle, enter/exit, SAFETY SL, manage-only |
| `/workspace/apps/control-api/src/services/exitManage.ts` | `decideBestOutcomeExit`, thesis, PeakProtection |
| `/workspace/apps/control-api/src/services/intentFanout.ts` | ENTRY_READY → Capital fan-out + manage attach |
| `/workspace/apps/control-api/src/services/capitalCom.ts` | Capital REST, quotes, positions, `computeSafetyCushionStopLevel`, late-move |
| `/workspace/apps/control-api/src/services/regimes.ts` | 14 režīmu classifier no 10s OHLC |
| `/workspace/apps/control-api/src/services/entryFromRegime.ts` | Regime → setup/direction |
| `/workspace/apps/control-api/src/services/tenSecondOhlc.ts` | Native 10s OHLC |
| `/workspace/apps/control-api/src/services/robotReader.ts` | Multi-feed read, pick OHLC mid, soft entry gate |
| `/workspace/apps/control-api/src/services/publicInternetFeeds.ts` | Yahoo/FX/metal/Coinbase + fuse |
| `/workspace/apps/control-api/src/services/staleQuoteGuard.ts` | Capital lag vs fresher refs |
| `/workspace/apps/control-api/src/services/clientPanel.ts` | Client START/STOP; entry vs manage-only |
| `/workspace/apps/control-api/src/services/clientSubscriptions.ts` | Active epic subscriptions |
| `/workspace/apps/control-api/src/routes/pipeline.ts` | Intent ingest HTTP |

### Testi (relevant)

| Fails |
|-------|
| `tradingQuality.test.ts` — SAFETY 0.20% + 1m late-move |
| `exitManage.test.ts` — BO / thesis / peak |
| `entryFromRegime.test.ts`, `regimes.test.ts`, `tenSecondOhlc.test.ts` |
| `staleQuoteGuard.test.ts`, `robotReader.test.ts` |
| `clientIsolation.test.ts`, `clientPipelineChain.test.ts`, `intentFanout.test.ts` |

### Docs pie snapshot

| Docs | Piezīme |
|------|---------|
| `docs/EXIT_ENGINE.md`, `ENTRY_ENGINE.md`, `REGIMES.md`, `TEN_SECOND_OHLC.md` | Galvenokārt C++ / dizains |
| `docs/TRADING_SL_SETUP_FIX.md` | **Novecojis** pret 0.20% kodu |
| `docs/POSITION_ENGINE.md` | C++ peak 0.5 ≠ Node 0.3/0.4 |
| `config/exit-policy.yaml` | C++ policy; nav Node BO avots |

### C++ (paralēlais engine; nav Robot Desk hot path)

| Path | Loma |
|------|------|
| `libs/entry-engine`, `libs/exit-engine`, `libs/regime-engine` | Spec engines |
| `libs/position-engine` | MFE/peak evaluate |
| `libs/feed-fusion`, `libs/feature-engine` | Consensus / 10s features |
| `apps/market-core` | Pipeline orchestration |

---

## 12. Secinājums operatoram

Pin **`e0e479a` (17:43)** = “Best Outcome setup” konteksts ar **nedaudz ciešāku SAFETY SL (0.20%)**. Live sistēma jau spēj: multi-feed 10s OHLC, regime entries, stale-quote skip, BO manage, manage-only pēc pipeline fill. Vājākās vietas šajā snapshot ir **SL-less entry fallback**, **dokumentācijas/C++ vs Node parametru šķelšanās**, un **multi-feed gate, kas nebloķē**. `STOP_TOO_WIDE` šeit vēl neeksistē.

---

*Audits ģenerēts no checkout `e0e479a` · faktisks kods citēts ar failiem un rindām.*
