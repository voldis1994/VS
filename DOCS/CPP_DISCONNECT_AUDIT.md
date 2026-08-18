# Audits: kas tika izmainīts, kad C++ tika nepareizi interpretēts

**Status:** tikai izmaiņu audits. C++ bibliotēkas **nav izdzēstas**.  
**Datums:** 2026-08-18  
**Tvērums:** tikai tas, kas tika pārslēgts / atvienots / arhivēts. Nav pilns produkta audits.

## Spriedums

C++ bija **aprēķina slānis** (vēna, EV, visi logi, labākais pirms un pēc atvēršanas). Node/Capital bija **izpilde**.

Aģenti to nolasīja kā “otro LIVE smadzeni” un:

1. **pārtrauca palaist** `market-core.exe`
2. **ignorēja** C++ `EntryReady` intentus, kad Node `robotDesk` ir ieslēgts
3. **neatgriezeniski aizvēra** pipeline atvērēju (`intentFanout` nevar atvērt Capital)
4. **pārcēla** C++ + ROBOT BOARD + Brokers uz `old version/`
5. **aizslēdza** to ar testiem

Kods palika. **Savienojums tika sabojāts.**

---

## Kas NAV izmainīts (joprojām arhīvā)

Šie faili tika **pārcelti**, ne izdzēsti:

| Dzinējs | Ceļš tagad | Loma (pēc koda, ne pēc aģenta komentāra) |
|---|---|---|
| FeatureEngine | `old version/architecture/legacy-review/libs/feature-engine/` | 10 ms–60 s logi: velocity, flow, MFE/MAE |
| FeedFusion | `…/libs/feed-fusion/` | consensus / divergence / lead-lag |
| MarketState | `…/libs/market-state/` | vēna: direction, structure, flow, liquidity |
| Regime / Setup / Evidence | `…/libs/regime-engine` `setup-engine` `evidence-engine` | konteksts pirms EV |
| EntryEngine | `…/libs/entry-engine/` | EV pirms atvēršanas → `EntryReady` |
| Position / Exit | `…/libs/position-engine` `exit-engine` | MFE/MAE, hold/exit/trail/TP atvērtam treidam |
| market-core | `old version/architecture/legacy-review/legacy-review/apps/market-core/` | pipeline + `drain_pending_intents()` → HTTP |

`market-core` **bridge** (`main.cpp` ~177–206) jau prot publicēt:

`POST /api/pipeline/intents` ar `x-pipeline-token`, `decision=ENTRY_READY`, epic, virziens, EV paskaidrojums.

Tas ir pareizais tilts. Tas netika izdzēsts. Tas tika **pārtraukts no otras puses**.

---

## Laika līnija — tikai izmaiņas

### 1. 2026-08-12 `398bbb5` — tuvu tavai iecerei

`Fix Client Panel: subscription + pipeline fan-out, not robotDesk brain`

Klienta START = tikai abonements. Gaida Market Core. Statuss: *Waiting for Market Core to analyze market*.

Šis **atbilst** C++ kā aprēķinam. Node šeit vēl nav “vienīgās smadzenes”.

### 2. 2026-08-14 `12bf3c5` — palaidējs C++ izlaiž

`skip C++ market-core when API keys are missing`

`tools/vs-restart/stack.go` (tagad arhīvā):

- `MARKET_CORE_BRIDGE=0` pēc noklusējuma
- C++ palaiž **tikai** ja ir īsts `PIPELINE_TOKEN` **un** Capital atslēgas `.env` (ne DB)
- citādi: `taskkill market-core.exe` + logs  
  **`C++ LIVE bridge IZLAISTS — tirgošana iet caur Node robotDesk + Capital (DB)`**
- `execution-service` vienmēr izlaists (papīra demo)

**Izmaiņa:** C++ process vairs neieiet parastajā startā. Brokeris DB paliek; C++ to neredz, jo grib `.env`.

### 3. 2026-08-14 `a9944c1` — galvenā nepareizā interpretācija

`Wire client START to Node robotDesk so VS.bat actually runs the TypeScript brain`

Commit ziņojums: *Client panel START was only activating a C++ pipeline subscription, so every entry/SL/trend fix never executed.*

Tā ir kļūda pret tavu dizainu. START **bija jāgaida C++ analīze**, ne jāaizvieto ar Node.

Konkrētās koda izmaiņas (joprojām production):

| Fails | Pirms | Pēc |
|---|---|---|
| `clientPanel.ts` | START = subscription; status *Waiting for Market Core* | START = `startRobotSession`; *C++ intents are ignored* |
| `intentFanout.ts` | C++ `EntryReady` → Capital | ja Node robot skrien: `SKIP · Node robotDesk owns entries` |
| `robotDesk.ts` | — | `hasEntryEnabledRobot()` ar komentāru *ignore stale C++ intents* |
| `RobotDeskPage.tsx` | — | header `NODE BRAIN` |

Tests `clientPipelineChain.test.ts`:  
*skips C++/pipeline Capital orders when Node entry robot is running*.

### 4. 2026-08-16 ap `76104e9` / B3 — otrais slēdzene

`SERVER/control-api/src/vs-core/moneyPathGate.ts` → `assertAuthoritativeOpener()`:

```
allowed: false
code: ALTERNATE_OPENER_DISABLED
reason: Production money path refuses opener 'intentFanout'
        — use robotDesk durable executeTradeIntent only
```

Funkcija **vienmēr** atgriež `allowed: false`. Nav karoga “C++ drīkst”.

`intentFanout.ts` pēc SKIP vēl sauc šo vārtu un **neatver** Capital no pipeline.

Tests `highGaps.b3b7.test.ts`: *intentFanout and admin_trading_orders cannot open*.

**Pat ja `market-core` publicē `EntryReady`, Node to noraida.** Divas slēdzenes:

1. Node robot “owns entries” → SKIP  
2. B3 → pipeline atvērējs vispār aizliegts  

### 5. 2026-08-16 `6a16918` — C++ izņemts no saknes

`feat: production rebuild foundation`

Pārcelšana (saturs 0 rindu, tikai ceļš):

- `libs/*` → `legacy-review/libs/`
- `apps/market-core`, `apps/execution-service` → `legacy-review/apps/`
- `PALAID.bat`, `VS.bat`, `VS.exe`, `FIX.ps1` → `legacy-review/windows-native/`

Jauns fails `legacy-review/CPP_LIBS_FROZEN.md`:

> frozen for the Node VS-CORE-01 path. **Do not import** from `SERVER/control-api`.

### 6. 2026-08-16 `c8c4b3e` → `72ab537` → 2026-08-17 `08e0cee`

C++ + TACTICAL DESK (`apps/dashboard`: ROBOT BOARD, Brokers, Trading PULL) → `Old-system/` → `legacy-review/` → **`old version/`**.

Production paliek i3 Node + PySide Admin. Tests:

- `TESTS/unit/no-legacy-ui-imports.test.ts` — production **nedrīkst** importēt `old version/`
- `TESTS/unit/admin-no-legacy-ui.test.ts` — aizliedz `TACTICAL DESK` / `ROBOT BRAIN` production Adminā

### 7. 2026-08-17 `22267c2` — Admin bez stūres

Native `VS Admin.exe`. Nav Brokers lapas. Nav ROBOT DEPLOY/START/STOP. Trading = KPI.  
Accounts `LOAD CATALOG` = `GET …/instruments` (**nav** `POST pull-capital-markets`).

Capital kataloga API **paliek** serverī. UI pogu noņem.

### 8. 2026-08-18 `714857a` (cita PR) — PALAID vārds, ne C++

`PALAID.bat` saknē atkal ir, bet tas tikai sauc `START_MSI.bat`.  
**C++ netika atjaunots.** Šis audits to tikai fiksē.

---

## Trīs slēdzenes, kas joprojām ir `main`

Viss zemāk ir **production** `SERVER/control-api`, ne arhīvs.

```
C++ EntryEngine
    → pending_intents_
    → drain → POST /api/pipeline/intents     ← tilts KODĀ VĒL IR (arhīvā)
                    ↓
         registerPipelineRoutes (production)  ← API vēl klausās
                    ↓
         intentFanout.executeForSubscription
                    ↓
         [1] hasEntryEnabledRobot? → SKIP · Node owns entries
                    ↓
         [2] assertAuthoritativeOpener('intentFanout')
                    → ALWAYS ALTERNATE_OPENER_DISABLED
                    ↓
         Capital createPosition  ← no C++ šeit NEAIZET
```

Node `robotDesk.enterTrade` → `createCapitalPosition` ir **vienīgais** atvērējs.  
Tas ir saīsināts Node cikls (~2 s, 10 s OHLC, SL 0.20%), **ne** FeatureEngine vēna / EV uz visiem logiem.

---

## Kas tika izmainīts operatora sejā (tikai UI pārvietošana)

| Bija (dashboard, tagad arhīvs) | Tagad (ADMIN/desktop) |
|---|---|
| Brokers Save/Test → `/api/brokers` | nav lapas |
| Trading **PULL 3000+** → `pull-capital-markets` | LOAD CATALOG = GET DB, bez PULL |
| ROBOT BOARD DEPLOY/START/STOP, 14 režīmi, OHLC, SL | Trading KPI, nav pogu |
| `GET /api/robot-desk` dzīvs poll | `live.py` šo API **nesauc** |

Servera maršruti (`/api/brokers`, `/api/robot-desk`, `/api/pipeline/intents`, `pull-capital-markets`) **nav dzēsti**. Dzēsta ir piesaite.

---

## Ko tas nozīmē tev

| Tavs dizains | Pēc izmaiņām |
|---|---|
| C++ rēķina vēnu / EV no visiem datiem | C++ process netiek palaists |
| `EntryReady` iet uz Node rokām | Node SKIP + B3 noraida |
| Capital izpilda C++ lēmumu | Capital izpilda tikai Node `robotDesk` |
| 3000+ katalogs paliek | kataloga API paliek; PULL poga pazuda no Admin |
| Brokeris DB paliek | paliek; C++ palaidējs to neizmanto (.env vs DB) |

Sajūta “izsūtīšana līdz galam nestrādāja” + “brokeris un 3000 tirgi bija”: **lasīšana (sesija, katalogs) palika; C++ lēmums līdz `createPosition` tika nogriezts ar šīm izmaiņām.**

---

## Kas jāatjauno, lai labotu tieši šīs izmaiņas

Ne jauns kodols. Atcelt trīs slēdzenes un atgriezt palaišanu:

1. Palaist `market-core --bridge` pret DB Capital sesiju (ne tikai `.env`).
2. `intentFanout`: C++ `ENTRY_READY` **drīkst** atvērt; noņemt `SKIP · Node owns entries` kā noklusējumu.
3. `assertAuthoritativeOpener('intentFanout')` — ļaut pipeline, kad avots ir market-core (`x-pipeline-token`), ne browseris.
4. Node `robotDesk` = izpilde + SL uz Capital, **ne** vienīgais lēmums.
5. Admin: Brokers + PULL + ROBOT / vēnas rādījums no C++ (režīms, EV, setup), ne tikai KPI.
6. Testi, kas **prasa** ignorēt C++, jāapgriež: C++ intentam jāaiziet līdz Capital mock.

C++ `libs/` pārrakstīt nav vajadzīgs — tie nav tie, kas tika “salaboti uz nederīgu”. Tika izmainīts **tilts un politika**.
