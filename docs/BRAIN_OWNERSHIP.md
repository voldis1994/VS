# Smadzenes ownership — kas IR / kas NAV (pēc #667 kļūdām)

Datums: 2026-10-01 · bāze **`main` = #666** (one-market + regime runner, MAP **212/212**).  
PR **#667 aizvērts / branch dzēsts** — “katrs literālis → Genome” ceļš noraidīts.

---

## 1. Ārpusē — NEDRĪKST Genome (īstā robeža)

| # | Kas | Kāpēc |
|---|---|---|
| 1 | `lot_size` | operators / riska kapitāls |
| 2 | Capital dealing-rules (min stop / point size) | broker API — clamp virs genome SAFETY, ne evolūcija |
| 3 | Sistēma: session / timers / busy / reconnect / DB / WS / auth / routing | infra, ne treidings |

Šie trīs ir **vienīgie** hard “ārpusē”. Viss pārējais zemāk ir vai nu smadzenes, vai **kods (procedūra)** — bet **ne** “jauns Genome knob katram literālim”.

---

## 2. NAV smadzenes — #667 kļūdas (NEDRĪKST atkārtot)

Šīs lietas **nav** “trūkstoši knobs”. Tās ir **procedūra / meta / broker-ops**. #667 mēģināja tās ielikt Genome un uzpūta MAP līdz 431 — tas bija nepareizais ceļš.

### 2.1 Procedūras struktūra (paliek kodā)

- Lane ↔ regime ↔ setup **kartes** un priority koki (`entryPlaybook`)
- Zone thirds / lookback ģeometrija (ne evolvable “recipe”)
- Same-family / strong switch `confirm = 1` kā **struktūras** likums (ne `regime_same_family_confirm_bars` knob spam)
- Boolean playbook receptes (kurš režīms → kurš gate), ja tie nav Soft/Peak forma

### 2.2 AutoCal “mācīšanās-par-mācīšanos” (META — nav treidings)

- Mutation **step** / **min/max bounds** (`auto_cal_mut_*_step`, `*_min`, `*_max`)
- Count triggeri tipa `≥2` / `≥1` kā atsevišķi knobs katram if
- Learning step size pašu AutoCal iekšējai politikai (smadzenes jau saņem **rezultātu** — Soft/Peak/genome patch)

Auto-cal = **ieteikums smadzenēm** (raksta genome kandidātu), nevis otrā smadze ar 100 meta-knobs.

### 2.3 SAFETY broker-ops (tuvu dealing-rules)

- Price-bucket robežas `1000/100/10/1` noapaļošanai
- Broker reject **loosen** soļi `[1, 1.15, …]`
- Phantom TP fallback `entry ± max(|entry|×5%, 80)`
- `minPts × 3` kā broker distance floor

**Uz smadzenēm** ir SAFETY **trading shape** (cushion bp, TP R:R).  
**Nav** smadzenes — kā Capital API retry / shove TP, ja brokeris neļauj.

### 2.4 MAP `N/N` meli

`auditGenomeOwnership` **N/N** = schema + consumer string + hypothesize.  
Tas **ne** nozīmē “nav neviena literāļa” un **ne** attaisno jaunu knob katram `Math.max`.

### 2.5 Dual-truth / paralēli literāļi (īstā problēma)

Labāk nekā jauns knob: **wire esošo** Genome key, ja kods joprojām lieto literāli blakus (`struct_extreme_*` vs `0.85`, `deep_giveback_offset` vs `0.12`).

---

## 3. JĀBŪT smadzenēm — treidings

### 3.1 Soft / Peak / Target forma

- Soft L1/L2/L3 abs + Soft pct  
- Target L1/L2/L3 abs + Target pct  
- Peak MFE abs/pct, Keep (viena ar genome), min giveback  
- Soft+ giveback / runner / leg / layer unlock / pullback episode Soft×  
- Layer percentile shape, stretch gate (ja regulē peļņas formu)

### 3.2 SAFETY trading shape (ne broker retry)

- SL cushion (bp / ×broker min)  
- SAFETY TP R:R (`safety_tp_rr`) — ar dealing-rules **clamp** apakšā  
- Abs floor **kā riska forma** (hi/mid/lo / tiny·nano **bp**), ne bucket robežas

### 3.3 Regime / entry / story

- Regime body ladder (bp), persist, dwell, confirm, RANGE chop gates  
- Zone bars / min bars / switch gap (skaitļi, ne Math.max floor kodā virs sanitize)  
- Structure bands, tip/post-impulse **trading** sliekšņi (ON/OFF + share/eff)  
- Story PATH/CHASE/CONF, trek firm, bounce/dip **kā treidinga forma** (ne katrs `redR≥3` kā atsevišķs meta-knob bez vajadzības)  
- Multi-TF: trek flat, HTF veto, aligned side, story conf min

### 3.4 Mind / manage / exit

- Mind entry/manage confidence + Soft× CUT/bank  
- manageBrain score weights (path / story / pressure)  
- Soft-exit market gate, grace/confirm, TimeDecay floors (bp)  
- Regime runner **trading** knobs (eligible, retain, deduct) — ne score-floor meta spam

### 3.5 Viena smadze — BrainGenome dara visu treidingu

- Soft / Peak / Target / SAFETY / regimes / filters — **tikai BrainGenome**
- Manual desk PUT **strips** Soft/Peak/Target — UI read-only
- **AutoCal** = Genome **self-update** no closes (`setBrainGenome` only — **nekad** desk SoT)
- **Learner** **nelemj** manage action (Mind/Genome lemj; learner tikai features)
- Nav “acis / rokas / otrā smadze” — viens Genome, viss treidings

---

## 4. Pašreizējais `main` (#666) stāvoklis

| | |
|---|---|
| Merge | `#666` one-market truth + regime runner (200–212) |
| MAP audit | **212/212** schema+wire+hypo |
| `EVOLVABLE_GENOME_KEYS` | ~336 |
| #667 | **CLOSED** · branch `cursor/block-late-tip-entry-e06a` **deleted** |

Confirm-list vēsture: `docs/BRAIN_CONFIRM_LIST.md` (212).  
Mērķa politika (vecāka): `docs/BRAIN_OWNERSHIP_TARGET.md`.

---

## 5. Darba likumi turpmāk (anti-#667)

1. **Vispirms** wire esošo unused Genome key — ne pievienot dublikātu.  
2. Jauns knob **tikai** ja tas maina Soft/Peak/Target/SAFETY **treidinga formu** vai entry/regime **lēmumu**, ko smadzenes var evolucionēt.  
3. **Ne** Genome-izēt: AutoCal mut steps/bounds, broker loosen/TP shove, zone-thirds ģeometriju, katru `≥2` count.  
4. MAP `N/N` ≠ “100% smadzenes” — proof = live flip tests + dual-truth 0.  
5. Dealing-rules paliek **clamp**, ne knob.

---

## 6. Īsā tabula

| Klase | Piemēri | Genome? |
|---|---|---|
| Operators | `lot_size` | **NĒ** |
| Broker dealing | min stop / point size | **NĒ** (clamp) |
| Infra | timers / DB / WS / auth | **NĒ** |
| Procedūra | lane maps, thirds, priority tree | **NĒ** (kods) |
| AutoCal meta | `*_mut_*` step/bounds, count≥N spam | **NĒ** |
| Broker SAFETY ops | loosen[], TP±5%/80, buckets | **NĒ** |
| Soft/Peak/Target forma | abs, Keep, Soft×, layers | **JĀ** (desk UI read-only) |
| SAFETY forma | cushion bp, TP RR | **JĀ** (+ clamp) |
| Regime/entry/story/mind/exit | ladder, tip flags, conf, scores | **JĀ** |

---

## 7. Kas vēl paliek (pēc desk dual-SoT noņemšanas)

| # | Gaps | Status |
|---|---|---|
| 1 | Manual desk Soft/Peak/Target PUT | **NOŅEMTS** — strip + UI read-only |
| 2 | Live Soft/Peak/Target read | Genome overlay caur `getDeskCalibration` |
| 3 | `effectivePeakKeep` / `peak_keep`↔`peak_retention` | **VIENS Keep** — `peak_keep` SoT, retention alias |
| 4 | AutoCal joprojām raksta desk+genome | OK kā “ieteikums smadzenēm”; nav otrā manuālā SoT |
| 5 | `struct_extreme_*` tipChase hardcode | **WIRED** — RANGE_FADE lieto extremeHi/Lo |
| 6 | `deep_giveback_offset` robotDesk | **WIRED** (vairs ne hardcode 0.12) |
| 7 | manage/mind deep-green Soft× `0.85` | **WIRED** → `near_target_lean_bank` |

---

## 8. LEARN FROM SCRATCH ( Capitals + klienti paliek )

`SĀKT NO JAUNA` = tikai desk Soft/Peak + auto-cal watch.  
**Pilnais wipe** (genome + learners + vēsture → factory):

- Windows: dubultklikšķis **`LEARN_FROM_SCRATCH.bat`** (ieraksti `LEARN_FROM_SCRATCH`)
  - open deal: `LEARN_FROM_SCRATCH.bat --force-open`
- UI COMMAND: **LEARN FROM SCRATCH** (apstiprina `LEARN_FROM_SCRATCH`)
- API: `POST /api/system/factory-reset-learning` `{ "confirm": "LEARN_FROM_SCRATCH" }`
- CLI: `cd apps/control-api && npx tsx scripts/factoryResetLearning.ts --yes`

**KEEP:** clients, Capital credentials, broker accounts, capital_markets, lot.  
**WIPE:** genome→DEFAULT, experience, Soft/Peak/Target, learners, auto-cal, trades/positions/audit.  
Pirms tam: FLAT/close robotus (vai `force_open_trades: true`).
