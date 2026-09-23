/** Live ENTRY WATCH — what the robot is reading / waiting for (all regimes). */
import type { RegimeName } from './regimes.js';
import {
  MIN_BARS_FOR_ZONE,
  ZONE_BARS,
  normalizeRegime,
} from './regimes.js';
import type { RegimeEntry } from './entryFromRegime.js';
import { decideEntryWithStructure } from './structureEntry.js';
import { bodyPct, isMoving10s, rangePct, type TenSecBar } from './tenSecondOhlc.js';
import { regimeAllowedForEntry, getDeskCalibration } from './deskCalibration.js';
import {
  flipFilterReason,
  requiredFlipSide,
  sameDirLockLeftSec,
  sameDirectionBlocked,
} from './flipFilter.js';
import { ENTRY_DIP, ENTRY_RALLY, MOVE, MOVE_RANGE } from './regimeBands.js';

const DIP = ENTRY_DIP;
const RALLY = ENTRY_RALLY;
const MOVING_BODY = MOVE;
const MOVING_RANGE = MOVE_RANGE;

export type EntryWatchStatus =
  | 'STOPPED'
  | 'MANAGE'
  | 'MANAGE_ONLY'
  | 'COOLDOWN'
  | 'SEEDING'
  | 'FORMING'
  | 'REGIME_OFF'
  | 'FLIP_FILTER'
  | 'WAITING_TRIGGER'
  | 'ARMED'
  | 'ENTERING';

export type EntryWatch = {
  regime: RegimeName;
  regime_enabled: boolean;
  enabled_regimes: RegimeName[];
  status: EntryWatchStatus;
  /** Human: what we need before entry */
  looking_for: string;
  /** Human: how the current bar relates to the trigger */
  bar_vs_trigger: string;
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  armed: boolean;
  /** Last closed side — same side blocked for 3 min after close */
  last_closed_side: 'BUY' | 'SELL' | null;
  /** Required flip side while 3m lock active, or null when lock expired */
  need_side: 'BUY' | 'SELL' | null;
  /** Seconds left on same-direction lock (0 = expired / inactive) */
  lock_left_s: number;
  /** Closed 10s candles already in the structure book */
  zone_bars: number;
  /** Min candles before regime trusts the zone (≈15m) */
  zone_need: number;
  /** Full structure zone target (≈30m) */
  zone_full: number;
  /** Candles still needed to reach zone_need (0 when ready) */
  zone_left: number;
  /** True once zone_bars ≥ zone_need */
  zone_ready: boolean;
  /** Human: e.g. "45/90 sveces · vēl 45 (≈8m)" */
  zone_progress: string;
  threshold_body_pct: number;
  bar: {
    o: number | null;
    h: number | null;
    l: number | null;
    c: number | null;
    forming_c: number | null;
    body_pct: number | null;
    range_pct: number | null;
    market: 'MOVING' | 'QUIET' | 'SEEDING';
    closed: boolean;
  };
  last_reason: string;
};

/** How many 10s candles the zone has vs min/full targets. */
export function zoneBarProgress(have: number): {
  zone_bars: number;
  zone_need: number;
  zone_full: number;
  zone_left: number;
  zone_ready: boolean;
  zone_progress: string;
} {
  const n = Math.max(0, Math.floor(Number(have) || 0));
  const left = Math.max(0, MIN_BARS_FOR_ZONE - n);
  const ready = left === 0;
  let zone_progress: string;
  if (!ready) {
    const mins = Math.max(1, Math.ceil((left * 10) / 60));
    zone_progress = `${n}/${MIN_BARS_FOR_ZONE} sveces · vēl ${left} (≈${mins}m)`;
  } else if (n < ZONE_BARS) {
    zone_progress = `${n}/${ZONE_BARS} sveces · min OK · pilna zona vēl ${ZONE_BARS - n}`;
  } else {
    zone_progress = `${n}/${ZONE_BARS} sveces · zona pilna`;
  }
  return {
    zone_bars: n,
    zone_need: MIN_BARS_FOR_ZONE,
    zone_full: ZONE_BARS,
    zone_left: left,
    zone_ready: ready,
    zone_progress,
  };
}

function pctStr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const p = v * 100;
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(3)}%`;
}

function marketOf(bar: TenSecBar | null | undefined): 'MOVING' | 'QUIET' | 'SEEDING' {
  if (!bar) return 'SEEDING';
  return isMoving10s(bar) ? 'MOVING' : 'QUIET';
}

/** Static watch recipe for each regime (shown even while forming). */
export function watchRecipe(regime?: string | null): {
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  looking_for: string;
  threshold_body_pct: number;
} {
  const r = normalizeRegime(regime);
  switch (r) {
    case 'TREND_UP':
      return {
        direction: 'BUY',
        setup: 'PULLBACK',
        looking_for:
          'TREND_UP · DIP pie zonas LO / structure+1m · ne chase HI',
        threshold_body_pct: DIP,
      };
    case 'TREND_DOWN':
      return {
        direction: 'SELL',
        setup: 'PULLBACK',
        looking_for:
          'TREND_DOWN · RALLY pie zonas HI / structure+1m · ne chase LO',
        threshold_body_pct: RALLY,
      };
    case 'PULLBACK_UPTREND':
      return {
        direction: 'BUY',
        setup: 'CONTINUATION',
        looking_for: 'PULLBACK_UPTREND · gaida RALLY (resume long) → BUY',
        threshold_body_pct: RALLY,
      };
    case 'PULLBACK_DOWNTREND':
      return {
        direction: 'SELL',
        setup: 'CONTINUATION',
        looking_for: 'PULLBACK_DOWNTREND · gaida DIP (resume short) → SELL',
        threshold_body_pct: DIP,
      };
    case 'BREAKOUT_UP':
      return {
        direction: 'BUY',
        setup: 'BREAKOUT',
        looking_for: 'BREAKOUT_UP · follow up (ne DIP) uz MOVING 10s → BUY',
        threshold_body_pct: RALLY,
      };
    case 'BREAKOUT_DOWN':
      return {
        direction: 'SELL',
        setup: 'BREAKOUT',
        looking_for: 'BREAKOUT_DOWN · follow down (ne RALLY) uz MOVING 10s → SELL',
        threshold_body_pct: DIP,
      };
    case 'FAILED_BREAKOUT_UP':
      return {
        direction: 'SELL',
        setup: 'FADE',
        looking_for: 'FAILED_BREAKOUT_UP · fade · gaida DIP → SELL',
        threshold_body_pct: DIP,
      };
    case 'FAILED_BREAKOUT_DOWN':
      return {
        direction: 'BUY',
        setup: 'FADE',
        looking_for: 'FAILED_BREAKOUT_DOWN · fade · gaida RALLY → BUY',
        threshold_body_pct: RALLY,
      };
    case 'REVERSAL_CANDIDATE':
      return {
        direction: null,
        setup: 'REVERSAL',
        looking_for: 'REVERSAL · DIP → SELL · RALLY → BUY (MOVING 10s)',
        threshold_body_pct: MOVING_BODY,
      };
    case 'EXPANSION':
      return {
        direction: null,
        setup: 'BREAKOUT',
        looking_for: 'EXPANSION · follow body · RALLY → BUY · DIP → SELL',
        threshold_body_pct: MOVING_BODY,
      };
    case 'RANGE':
      return {
        direction: null,
        setup: 'FADE',
        looking_for: 'RANGE · fade tikai pie LO/HI · mid-zona = chase WAIT',
        threshold_body_pct: MOVING_BODY,
      };
    case 'COMPRESSION':
      return {
        direction: null,
        setup: 'FADE',
        looking_for: 'COMPRESSION · micro fade uz MOVING 10s · SPIKE → WAIT (no chase)',
        threshold_body_pct: MOVING_BODY,
      };
    case 'TRANSITION':
      return {
        direction: null,
        setup: 'BREAKOUT',
        looking_for: 'TRANSITION · follow body · RALLY → BUY · DIP → SELL (MOVING 10s)',
        threshold_body_pct: MOVING_BODY,
      };
    case 'UNKNOWN':
    default:
      return {
        direction: null,
        setup: null,
        looking_for: 'UNKNOWN · lasa tirgu, režīms vēl neveidojas',
        threshold_body_pct: MOVING_BODY,
      };
  }
}

function lookingForWithZone(
  base: string,
  zone: ReturnType<typeof zoneBarProgress>,
  regime: RegimeName
): string {
  if (!zone.zone_ready || regime === 'UNKNOWN') {
    return `${base} · ${zone.zone_progress}`;
  }
  return `${base} · zona ${zone.zone_bars}/${zone.zone_full}`;
}

function barVsTrigger(
  bar: TenSecBar | null | undefined,
  recipe: ReturnType<typeof watchRecipe>,
  sig: RegimeEntry | null
): string {
  if (!bar) return 'OHLC seeding…';
  const body = bodyPct(bar);
  const rng = rangePct(bar);
  const mkt = marketOf(bar);
  const bits = [
    `body ${pctStr(body)}`,
    `range ${pctStr(rng)}`,
    mkt,
    `trigger ±${pctStr(MOVING_BODY).replace('+', '')} body / ${pctStr(MOVING_RANGE)} range`,
  ];
  if (sig) {
    bits.push(`✓ TRIGERIS · ${sig.direction} ${sig.setup}`);
  } else if (mkt === 'QUIET') {
    bits.push('kluss bars — gaida MOVING');
  } else if (recipe.looking_for.includes('DIP') && recipe.looking_for.includes('RALLY')) {
    if (body <= DIP) bits.push('DIP zona');
    else if (body >= RALLY) bits.push('RALLY zona');
    else bits.push('gaida DIP vai RALLY');
  } else if (recipe.looking_for.includes('DIP') && body > DIP) {
    bits.push(`nav DIP (vajag ≤ ${pctStr(DIP)})`);
  } else if (recipe.looking_for.includes('RALLY') && body < RALLY) {
    bits.push(`nav RALLY (vajag ≥ ${pctStr(RALLY)})`);
  }
  return bits.join(' · ');
}

export type BuildWatchInput = {
  running: boolean;
  open_side: 'BUY' | 'SELL' | null;
  entry_enabled: boolean;
  regime: string | null | undefined;
  last_closed: TenSecBar | null | undefined;
  forming_c: number | null | undefined;
  just_closed: boolean;
  /** Closed 10s bars already in the robot structure book */
  closed_bar_count?: number;
  /** Full 10s book — enables zone+1m structure gate in watch ARM preview */
  closed_bars?: TenSecBar[];
  last_closed_side?: 'BUY' | 'SELL' | null;
  closed_at_ms?: number | null;
  cooldown_left_s?: number;
  status_override?: EntryWatchStatus | null;
  last_reason?: string;
};

export function buildEntryWatch(input: BuildWatchInput): EntryWatch {
  const regime = normalizeRegime(input.regime);
  const recipe = watchRecipe(regime);
  const enabled = getDeskCalibration().enabled_regimes;
  const regimeOn = regimeAllowedForEntry(regime);
  const zone = zoneBarProgress(input.closed_bar_count ?? 0);
  const bar = input.last_closed || null;
  const body = bar ? bodyPct(bar) : null;
  const rng = bar ? rangePct(bar) : null;
  const mkt = marketOf(bar);
  const lastClosedSide = input.last_closed_side ?? null;
  const closedAtMs = input.closed_at_ms ?? null;
  const lockLeft = sameDirLockLeftSec(closedAtMs);
  const needSide = requiredFlipSide(lastClosedSide, closedAtMs);
  const rawSig =
    bar && zone.zone_ready && regimeOn && input.entry_enabled && !input.open_side
      ? decideEntryWithStructure({
          bar,
          regime,
          closedBars: input.closed_bars?.length
            ? input.closed_bars
            : bar
              ? [bar]
              : [],
        })
      : null;
  const flipBlocked = Boolean(
    rawSig && sameDirectionBlocked(rawSig.direction, lastClosedSide, closedAtMs)
  );
  const sig = flipBlocked ? null : rawSig;

  let status: EntryWatchStatus = 'WAITING_TRIGGER';
  if (!input.running) status = 'STOPPED';
  else if (input.open_side) status = 'MANAGE';
  else if (!input.entry_enabled) status = 'MANAGE_ONLY';
  else if (input.cooldown_left_s && input.cooldown_left_s > 0) status = 'COOLDOWN';
  else if (input.status_override === 'FLIP_FILTER' || flipBlocked) status = 'FLIP_FILTER';
  else if (input.status_override) status = input.status_override;
  else if (!zone.zone_ready || !bar) status = 'SEEDING';
  else if (!input.just_closed) status = 'FORMING';
  else if (!regimeOn) status = 'REGIME_OFF';
  else if (sig) status = 'ARMED';
  else status = 'WAITING_TRIGGER';

  const vs = barVsTrigger(bar, recipe, sig);
  let last_reason = input.last_reason || '';
  if (!last_reason) {
    if (status === 'ARMED' && sig) last_reason = sig.reason;
    else if (status === 'FLIP_FILTER' && rawSig && lastClosedSide)
      last_reason = flipFilterReason(rawSig.direction, lastClosedSide, lockLeft);
    else if (status === 'FORMING') last_reason = 'Gaida 10s bāra aizvēršanos';
    else if (status === 'REGIME_OFF')
      last_reason = `${regime} OFF Control kalibrācijā — ieslēdz TRADE REGIMES`;
    else if (status === 'WAITING_TRIGGER') last_reason = `${regime} · ${vs}`;
    else if (status === 'MANAGE') last_reason = `Pozīcija ${input.open_side} — manage`;
    else if (status === 'MANAGE_ONLY') last_reason = 'Entry smadzenes OFF (manage-only)';
    else if (status === 'COOLDOWN')
      last_reason = `Cooldown ${input.cooldown_left_s}s pēc close`;
    else if (status === 'SEEDING')
      last_reason = zone.zone_ready
        ? 'Lasīt 10s OHLC…'
        : `Lasa tirgu · ${zone.zone_progress}`;
    else if (status === 'STOPPED') last_reason = 'Robots STOP';
  }

  const flipNote = needSide
    ? ` · FLIP LOCK 3m: last ${lastClosedSide} → ${needSide} only · ${lockLeft}s`
    : '';

  return {
    regime,
    regime_enabled: regimeOn,
    enabled_regimes: [...enabled],
    status,
    looking_for: lookingForWithZone(`${recipe.looking_for}${flipNote}`, zone, regime),
    bar_vs_trigger: vs,
    direction: sig?.direction ?? (flipBlocked ? needSide : recipe.direction),
    setup: sig?.setup ?? recipe.setup,
    armed: Boolean(sig) && status === 'ARMED',
    last_closed_side: lastClosedSide,
    need_side: needSide,
    lock_left_s: lockLeft,
    zone_bars: zone.zone_bars,
    zone_need: zone.zone_need,
    zone_full: zone.zone_full,
    zone_left: zone.zone_left,
    zone_ready: zone.zone_ready,
    zone_progress: zone.zone_progress,
    threshold_body_pct: recipe.threshold_body_pct,
    bar: {
      o: bar?.open ?? null,
      h: bar?.high ?? null,
      l: bar?.low ?? null,
      c: bar?.close ?? null,
      forming_c: input.forming_c ?? null,
      body_pct: body,
      range_pct: rng,
      market: mkt,
      closed: Boolean(input.just_closed && bar),
    },
    last_reason,
  };
}
