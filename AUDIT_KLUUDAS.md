# VS MAIN — Hard Audit: visas kļūdas un loģiskās pretrunas
Datums: 2026-08-20  
Repo tip (pēc P0 fix): `480ae43` / `origin/main`  
Produkta noteikums: **ENTRY = īsts setup · EXIT = Best Outcome only**

---

## A. KRITISKI (P0) — traucē dzīvajā tirdzniecībā

### A1. Close iestrēgst `CLOSE_PENDING` un nekad neaizver vēlreiz
- **Kur:** `robotDesk.ts` exitTrade + `exitLifecycle.ts` canIssueClose  
- **Kas notiek:** Pēc “HTTP close OK, bet broker vēl rāda open” robots tikai pārbauda flat un raksta `no duplicate close`. Ja Capital noraidīja / kavējas / palika otrā kāja — **DELETE vairs netiek sūtīts**.  
- **Loģika:** “Close pending” ≠ “vairs nekad neaizver”.  
- **Statuss:** SALABOTS (`CLOSE RETRY` pēc ~8s + durable clear).

### A2. Multi-deal close: 1 no N OK → `close_pending`, pārējie paliek
- **Kur:** `robotDesk.ts` exitTrade loop (`anyOk`)  
- **Kas notiek:** Epic ar BUY+SELL (hedžs): viena deal aizveras, otra fail → robots domā “close submitted” un iestrēgst.  
- **Loģika:** “Aizvērt epic” = **visas** rindas, nevis jebkura viena.  
- **Statuss:** SALABOTS (skaitītājs okCount / fail list; flat pēc visām rindām).

### A3. Capital close: HTTP 200 + `dealStatus=REJECTED` tiek uzskatīts par OK
- **Kur:** `capitalCom.ts` closeCapitalPosition  
- **Kas notiek:** Entry ceļš pārbauda confirm/dealStatus; close ceļš to ignorēja → fake “closed”.  
- **Loģika:** Open un close jāizmanto vienādi broker pierādījumi.  
- **Statuss:** SALABOTS (REJECTED/FAILED → ok:false + confirm ja ir dealRef).

### A4. C++ EntryReady, ko desk noraida, tomēr atver treidu
- **Kur:** `robotDesk.ts` pēc `resolveDeskEntry` — ja `hadDirection` un `resolved.direction=null`, vecā C++ puse palika  
- **Kas notiek:** Late chase / REGIME_BLOCK / STALE — desk saka NĒ, Capital tomēr saņem orderi.  
- **Loģika:** Desk ir pēdējais vārds pirms naudas. Noraidījums = **null**, nevis “paturi C++”.  
- **Statuss:** SALABOTS (hadDirection + denied → clear direction).

### A5. `FAILED_BREAKOUT_UP` tiek lasīts kā `BREAKOUT_UP`
- **Kur:** `deskEntry.ts` blockRegimeDirectionEntry (`includes('BREAKOUT_UP')`) + `entryDirectionGate.ts`  
- **Kas notiek:** Apstiprināts failed-breakout SELL tiek `REGIME_BLOCK` kā “SELL forbidden in up breakout”.  
- **Loģika:** FAILED_BREAKOUT ir **pretējs** setup ģimenei, ne breakout follow.  
- **Statuss:** SALABOTS (exact / !FAILED).

### A6. Zone manage bloķēja Best Outcome close (HOLD forever)
- **Kur:** vecais `robotDesk` zone path (pirms simplify)  
- **Kas notiek:** ZONE HOLD `return` pirms BO OPTIMIZATION → treids “nevar ciet”.  
- **Loģika:** Tu prasīji **tikai BO close**; zonas manage nav saderīgs ar to.  
- **Statuss:** SALABOTS (zone manage noņemts; BO only).

### A7. Opposite-order “partial” radīja BUY+SELL hedžu
- **Kur:** `reduceCapitalPosition` → pretējais market order  
- **Kas notiek:** Capital hedging kontā partial ≠ reduce; klients redz abu pušu pozīcijas; robots apjukst.  
- **Loģika:** Capital REST DELETE ir full-row; partial caur pretējo orderi **nav** drošs.  
- **Statuss:** SALABOTS (reduce disabled; hedge flatten; full close).

### A8. Windows palika uz vecā commit (`35804f1`) kamēr GitHub jau bija jaunāks
- **Kur:** `REBUILD_ALL.bat` / `START_MSI.bat` soft `git pull` + WARN continue  
- **Kas notiek:** Pull fail → rebuild ar **veco** kodu; šķiet, ka “GitHub niķojas”.  
- **Loģika:** Rebuild bez hard sync ≠ “esmu uz main tip”.  
- **Statuss:** SALABOTS (hard reset; START_MSI arī).

### A9. Telefona tastatūra sabojā git flagus (`--` → `–`)
- **Kur:** operators CMD no telefona  
- **Kas notiek:** `git reset –hard` / `git log –oneline` → fatal ambiguous argument.  
- **Loģika:** Tas nav GitHub bug; Smart Punctuation.  
- **Statuss:** PROCESS (izmantot `git checkout -B main origin/main` bez `--`).

---

## B. ENTRY — loģiski nesaderīgi / bloķē labus setup / laiž sliktus

### B1. TREND_UP CONTINUATION prasa `priorWasDip`; TREND_DOWN CONTINUATION — NĒ
- **Kur:** `entryFromRegime.ts` (~573–608); `priorWasRally` eksistē, **netiek lietots**  
- **Kas notiek:** DOWN dump chase uz dump kājas; UP ir stingrāks.  
- **Loģika:** Simetrija — dump CONTINUATION arī vajag prior bounce/rally.  
- **Statuss:** ATVĒRTS (P0/P1).

### B2. `blockLateCalcEntry` tikai C++ (`fromCalc`), ne Node BREAKOUT
- **Kur:** `deskEntry.ts`  
- **Kas notiek:** Tas pats late green bar: C++ bloķēts, Node BREAKOUT_UP var iet.  
- **Loģika:** Late chase ir late chase neatkarīgi no smadzenēm.  
- **Statuss:** ATVĒRTS (P0/P1).

### B3. Countertrend setup (FADE / rejection) atbrīvots no CONCEPT_BLOCK, bet ne no REGIME_BLOCK
- **Kur:** `deskEntry.ts` finish vs blockRegimeDirectionEntry  
- **Kas notiek:** FADE SELL + bias UP mirst kā REGIME_BLOCK pirms concept exemption.  
- **Loģika:** Ja setup ir countertrend by design, regime/bias hard block nedrīkst to nogalināt divreiz.  
- **Statuss:** DAĻĒJI (P0 fix atbrīvoja countertrend no regime block; jāverificē FADE live).

### B4. `entryDirectionGate` saņem `setup`, bet **neizmanto**
- **Kur:** `entryDirectionGate.ts` evaluateEntryDirectionGate  
- **Kas notiek:** FADE/RANGE_REJECTION/FAILED_BREAKOUT pret STRONG_UP → BLOCK, lai gan setup ir apzināti pretējs.  
- **Loģika:** Gate bez setup konteksta = struktūra bez setup nozīmes.  
- **Statuss:** ATVĒRTS (P0/P1).

### B5. `isRealEntrySetup` ar `includes('BREAKOUT')` utt.
- **Kur:** `deskEntry.ts`  
- **Kas notiek:** `FAKE_BREAKOUT` / `NO_PULLBACK` var iziet kā “real”.  
- **Loģika:** Substring ≠ whitelist.  
- **Statuss:** ATVĒRTS (P2).

### B6. “Waiting C++ first” 2.5s — teksts melo
- **Kur:** `robotDesk.ts` waitCalcFirst tikai nullē capitalMid LAG; Node entry joprojām var  
- **Kas notiek:** SCAN saka “waiting C++”, bet Node jau var atvērt.  
- **Loģika:** Vai nu īsti gaidi, vai neraksti, ka gaidi.  
- **Statuss:** ATVĒRTS (P2).

### B7. Stale C++ (>12s) discard, bet `calcSignalAgeMs` paliek → Node PULLBACK `STALE_SIGNAL`
- **Kur:** `robotDesk.ts`  
- **Kas notiek:** Noraidīts calc saindē nākamo derīgo Node setup.  
- **Loģika:** Discarded signal age ≠ current signal age.  
- **Statuss:** ATVĒRTS (P1).

### B8. Zone entry gate (swing demand/supply) + “īstais setup”
- **Kur:** bija `deskEntry` + `marketZones`  
- **Kas notiek:** Labs structured pullback bez zonas touch = NO_ZONE; mazāk treidu, citāda semantika nekā “real setup”.  
- **Loģika:** Tu prasīji setup+BO, ne zone-as-permission.  
- **Statuss:** SALABOTS (zone entry gate noņemts).

---

## C. EXIT / Best Outcome — loģiskās pretrunas

### C1. LIVE strong SAME signal (`d===-1`) veto **visus** OPTIMIZATION close, arī profit-lock
- **Kur:** `bestOutcomeLive.ts`  
- **Kas notiek:** Trends turpinās tajā pašā virzienā → BO candidate CLOSE → HOLD. Aizver tikai HARD_SAFETY / Safety SL.  
- **Loģika:** “Neizej agri” OK; “nekad neņem peļņu kamēr trends skrien” = BO kā TP gandrīz miris trendā.  
- **Statuss:** ATVĒRTS by design tests; produkta riska P0/P1.

### C2. OPTIMIZATION nekad neaizver UPL ≤ 0; HARD_SAFETY `ThesisFailure` var
- **Kur:** `bestOutcomeLive` + `exitManage` ThesisFailure  
- **Kas notiek:** Regime flip var aizvērt zaudētājā, kamēr “BO never closes negative” ir solīts OPTIMIZATION.  
- **Loģika:** Divas dažādas “never negative” politikas.  
- **Statuss:** ATVĒRTS (P1).

### C3. Meaningful UPL (~2pt) + 30s after first plus
- **Kur:** `bestOutcomeQuality` / `exitManage`  
- **Kas notiek:** Micro plus netiek aizvērts (labi pret chop); bet kopā ar C1 → “ilgi nevar ciet”.  
- **Loģika:** Aizsardzība pret noise + SAME hold = dubulta aizture.  
- **Statuss:** BY DESIGN (P2 tune).

### C4. Safety SL 0.40% vs README / vecie teksti 0.15% / “BO only moves SL to BE”
- **Kur:** docs vs `mainPrototype` / `capitalCom` SAFETY_SL_REL  
- **Kas notiek:** Operators lasa veco dokumentāciju.  
- **Loģika:** Docs ≠ kods.  
- **Statuss:** ATVĒRTS (P2 docs).

### C5. Dead zone fields (`zone_partial_done`, `remaining_lot`) + `marketZones.ts` vēl repo
- **Kur:** `robotDesk` state; `marketZones.ts`  
- **Kas notiek:** Live vairs neizmanto; risks atkal “uzlikt zones manage”.  
- **Loģika:** Dead code ≠ produkta noteikums.  
- **Statuss:** ATVĒRTS (P2 cleanup).

---

## D. Capital / broker — infrastruktūras kļūdas

### D1. Shared Capital session pool bez mutex
- **Kur:** `capitalCom.ts` acquire/switch  
- **Kas notiek:** Divi roboti / konti → list/close uz **nepareizā** account.  
- **Loģika:** Switch + trade nav atomisks.  
- **Statuss:** ATVĒRTS (P1).

### D2. Durable `isClosePending` katru ciklu atkal uzliek `close_pending`
- **Kur:** `robotDesk` sync + `durableOrderStore`  
- **Kas notiek:** Pat ja in-memory notīra, ledger atkal ieslēdz pending → bloķē retry (pirms fix).  
- **Loģika:** Durable “atceries” nedrīkst nozagt recovery.  
- **Statuss:** SALABOTS (`clearClosePending` → POSITION_OPEN).

### D3. List fail pirms close → tikai viens `deal_id`
- **Kur:** exitTrade fallback resolveDealId  
- **Kas notiek:** Hedža otrā kāja paliek.  
- **Loģika:** Bez epic list nedrīkst “close one and hope”.  
- **Statuss:** DAĻĒJI (labāk multi-deal; list-fail path vēl P1).

### D4. Hedge flatten tikai ja `marketOpen`
- **Kur:** robotDesk sync  
- **Kas notiek:** BUY+SELL kamēr status ≠ TRADEABLE → neflatten.  
- **Loģika:** Close bieži atļauts arī kad jauni entry nav.  
- **Statuss:** ATVĒRTS (P1).

### D5. Safety SL attach tikai uz `s.deal_id`, ne visām epic rindām
- **Kur:** manage SL attach  
- **Kas notiek:** Hedža kāja bez SL.  
- **Loģika:** Max 1 open noteikums + hedžs = neaizsargāta ekspozīcija.  
- **Statuss:** ATVĒRTS (P1).

---

## E. Klients / UI — “klientam nepareizi”

### E1. Client portal quote ņem **vecāko** tick (`ticks[length-1]`), desk — jaunāko (`ticks[0]`)
- **Kur:** `clientPanel.ts` vs `robotDesk` pushTick unshift  
- **Kas notiek:** Telefonā bid/ask “iesalst” session sākumā.  
- **Loģika:** Desk un klients jārāda **tā pati** cena.  
- **Statuss:** SALABOTS (`ticks[0]`).

### E2. `emitToClient` / `/ws/client` ir, CLIENT web **nav** WebSocket — tikai 3–8s poll
- **Kur:** CLIENT/web ClientPortal.tsx  
- **Kas notiek:** `trade_opened` / `robot_started` netiek uzreiz; status “lag”.  
- **Loģika:** Events bez listener = miruši.  
- **Statuss:** ATVĒRTS (P1).

### E3. `publicSession` noplūdina internal (`best_outcome_track`, `zone_partial_*`, cooldown…)
- **Kur:** robotDesk publicSession  
- **Kas notiek:** API shape piesārņots; UI var nepareizi lasīt.  
- **Loģika:** Public ≠ internal.  
- **Statuss:** ATVĒRTS (P1).

### E4. HTTPS URL → Secure cookie, bet gateway bieži HTTP :8443
- **Kur:** start-admin.ps1 client-url  
- **Kas notiek:** Safari nomet cookie; “logout” pēc refresh.  
- **Loģika:** Secure cookie tikai uz īstu TLS.  
- **Statuss:** ATVĒRTS (P1).

### E5. Stuck `STARTING` ja Node start fail
- **Kur:** clientPanel computeClientRobotStatus  
- **Kas notiek:** Nekad ERROR — mūžīgs STARTING.  
- **Loģika:** Fail = ERROR + reason.  
- **Statuss:** ATVĒRTS (P1).

---

## F. Windows / sync / divas mapes — “abi stāv uz commit”

### F1. `C:\VS` un `C:\VS-main` cīnās par Docker volume + shared PID
- **Kur:** docker-compose global names; `%LOCALAPPDATA%\VS\admin\vs-api.pid`  
- **Kas notiek:** Viens rebuild otru nogalina / DB wipe / nepareizs process.  
- **Loģika:** Viena kanoniskā mape: **C:\VS**.  
- **Statuss:** ATVĒRTS (P0 ops).

### F2. `UPDATE_VS.bat` preferē `C:\VS` arī ja `VS-main` ir jaunāks
- **Kur:** UPDATE_VS.bat  
- **Kas notiek:** Operators update VS-main, rebuild iet uz veco VS.  
- **Loģika:** “Update” jāzina, kuru tree.  
- **Statuss:** ATVĒRTS (P0 ops).

### F3. `PALAID.bat` / vecais soft pull (pirms fix)
- **Statuss:** START_MSI + REBUILD_ALL hard reset SALABOTS; PALAID joprojām var būt mīksts — pārbaudīt.

### F4. `BUILD_CALC.bat` bez g++/cl → “OK using shipped vs-calc.exe”
- **Kas notiek:** Jauns `vs-calc.cpp` netiek kompilēts → vecs EntryReady.  
- **Loģika:** Ship binary ≠ sync ar source.  
- **Statuss:** ATVĒRTS (P0/P1).

### F5. `START_MSI` / start-admin nestopē veco `vs-calc` pirms start
- **Kas notiek:** Divi vs-calc → dubults EntryReady.  
- **Loģika:** Viens brain process.  
- **Statuss:** ATVĒRTS (P0).

### F6. `.main-tip` fails ir write-only — kods to nelasa
- **Kur:** SERVER/control-api/.main-tip vs runtimeBuild  
- **Kas notiek:** Operators redz tip, runtime SHA no git — nav sasaistes fail-closed.  
- **Loģika:** Tip failam jābūt health check vai jādzēš.  
- **Statuss:** ATVĒRTS (P2).

---

## G. Produkta pretrunas (kas “neiet kopā” kā stāsts)

1. **“Tikai īsts setup + BO close”** vs vēsturiskie zone entry/exit/partial — zonas bija otrs produkts.  
2. **“BO aizver peļņā”** vs LIVE SAME HOLD, kas trendā gandrīz aizliedz OPTIMIZATION.  
3. **“Max 1 open”** vs opposite-order partial, kas rada 2 pozīcijas.  
4. **“Safety SL aizsargā”** vs micro Limit chop pie 0.15% (tagad 0.40% — labāk, bet docs atpaliek).  
5. **“Desk = patiesība”** vs C++ EntryReady, kas varēja apiet desk denial.  
6. **“Klients = tas pats robots”** vs vecs quote tick + bez WS.  
7. **“GitHub = main”** vs soft pull + 2 mapes + phone en-dash.  
8. **FAILED_BREAKOUT** nosaukumā satur BREAKOUT, bet semantika ir pretēja — substring matching ir bīstams visur.

---

## H. Kas JAU ir uz `origin/main` (salabots šajā auditā / iepriekš)

- Entry = real setup; Exit = BO only (zonas manage/entry gate ārā)  
- Desk denial honorēts  
- CLOSE RETRY + multi-deal + dealStatus/confirm  
- FAILED_BREAKOUT substring fix  
- Partial/hedge reduce disabled + hedge flatten  
- Client newest tick  
- REBUILD_ALL + START_MSI hard reset uz origin/main  
- `.main-tip` ar rule + audit rindu  

Pārbaudi Windows:
```
cd /d C:\VS
git fetch origin main
git checkout -B main origin/main
git log -1
type SERVER\control-api\.main-tip
REBUILD_ALL.bat
```
Gaidāmais: SHA `480ae43` (vai jaunāks) un tip `ENTRY real setup only · EXIT Best Outcome only`.

---

## I. Prioritāte nākamajam darbam (ja turpina)

1. P0 ops: **tikai C:\VS**, stop+kill vs-calc pirms start, calc rebuild fail-closed  
2. P1 exit: SAME signal nebloķē skaidru giveback/profit-lock (bez early-exit)  
3. P1 entry: TREND_DOWN `priorWasRally`; gate respektē countertrend setup; late-block arī Node  
4. P1 Capital: session mutex; SL uz visām epic rindām; hedge flatten arī kad entry closed  
5. P1 client: WebSocket; publicSession allowlist; STARTING→ERROR  
6. P2: dzēst dead zone state; README = 0.40% + BO close; `.main-tip` health
