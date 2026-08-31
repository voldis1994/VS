/**
 * Setup-first market model (LIVE desk brain).
 *
 * Capital quote + 1m (+ optional 1h) + 10s → STRUCTURE → SETUP → ENTRY → BEST OUTCOME
 *
 * Hard rules:
 * - Setup changes only on structure refresh / closed bars — never on every quote tick
 * - NONE = no tradeable setup (not a "WAIT regime")
 * - ARMED = setup ready; entry only on closed 10s confirm at the level
 * - Open trade freezes setup; manage = best outcome only
 */
import type { CapitalPriceCandle } from './capitalCom.js';
import type { TradePlaybook } from './playbooks.js';
import { PLAYBOOK_ENTRY_BODY } from './playbooks.js';
import { bodyPct, type TenSecBar } from './tenSecondOhlc.js';

export const SETUP_KINDS = [
  'CONTINUATION',
  'PULLBACK',
  'BREAKOUT',
  'FADE',
  'FAILED_BREAK',
  'NONE',
] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

export type SetupStatus = 'NONE' | 'FORMING' | 'ARMED';

export type StructureBook = {
  ready: boolean;
  swing_high: number;
  swing_low: number;
  mid: number;
  span: number;
  bias: 'ABOVE' | 'BELOW' | 'INSIDE';
  near_high: boolean;
  near_low: boolean;
  hour_bias: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
  bar_count: number;
  detail: string;
  updated_at: string;
};

export type MarketSetup = {
  kind: SetupKind;
  side: 'BUY' | 'SELL' | null;
  playbook: TradePlaybook | null;
  status: SetupStatus;
  swing_high: number;
  swing_low: number;
  reason: string;
  /** Sticky confirm counter — setup flips only after enough agreeing updates */
  confirm: number;
  updated_at: string;
};

export type SetupEntry = {
  direction: 'BUY' | 'SELL';
  setup: SetupKind;
  playbook: TradePlaybook;
  reason: string;
};

const MIN_SWING_BARS = 20;
const PIVOT_LEFT = 3;
const PIVOT_RIGHT = 3;
const SETUP_CONFIRM = 2;
/** Edge band in price points — Gold-friendly floor */
function edgeEps(px: number, span: number): number {
  return Math.max(Math.abs(px) * 0.00035, span * 0.08, 0.8);
}

export function emptyStructure(detail = 'structure seeding'): StructureBook {
  return {
    ready: false,
    swing_high: 0,
    swing_low: 0,
    mid: 0,
    span: 0,
    bias: 'INSIDE',
    near_high: false,
    near_low: false,
    hour_bias: 'UNKNOWN',
    bar_count: 0,
    detail,
    updated_at: new Date().toISOString(),
  };
}

export function emptySetup(reason = 'no setup'): MarketSetup {
  return {
    kind: 'NONE',
    side: null,
    playbook: null,
    status: 'NONE',
    swing_high: 0,
    swing_low: 0,
    reason,
    confirm: 0,
    updated_at: new Date().toISOString(),
  };
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Last swing high/low from minute pivots — remembered structure, not raw rolling max. */
export function detectSwingLevels(minutes: CapitalPriceCandle[]): {
  high: number;
  low: number;
  ok: boolean;
} {
  if (minutes.length < MIN_SWING_BARS) {
    return { high: 0, low: 0, ok: false };
  }
  const pivotsHi: number[] = [];
  const pivotsLo: number[] = [];
  for (let i = PIVOT_LEFT; i < minutes.length - PIVOT_RIGHT; i++) {
    const c = minutes[i]!;
    let isHi = true;
    let isLo = true;
    for (let j = i - PIVOT_LEFT; j <= i + PIVOT_RIGHT; j++) {
      if (j === i) continue;
      const o = minutes[j]!;
      if (o.high >= c.high) isHi = false;
      if (o.low <= c.low) isLo = false;
    }
    if (isHi) pivotsHi.push(c.high);
    if (isLo) pivotsLo.push(c.low);
  }
  // Prefer recent pivots; fall back to window extremes if sparse
  const high =
    pivotsHi.length > 0
      ? pivotsHi[pivotsHi.length - 1]!
      : Math.max(...minutes.slice(0, -1).map((c) => c.high));
  const low =
    pivotsLo.length > 0
      ? pivotsLo[pivotsLo.length - 1]!
      : Math.min(...minutes.slice(0, -1).map((c) => c.low));
  if (!(high > low)) return { high: 0, low: 0, ok: false };
  return { high, low, ok: true };
}

function hourBiasFrom(hours: CapitalPriceCandle[] | null | undefined): StructureBook['hour_bias'] {
  if (!hours || hours.length < 3) return 'UNKNOWN';
  const last = hours.slice(-6);
  const bodies = last.map((c) => (c.close - c.open) / Math.max(Math.abs(c.open), 1e-9));
  const p = mean(bodies.map((v) => (v > 0.0002 ? 1 : v < -0.0002 ? -1 : 0)));
  if (p > 0.35) return 'UP';
  if (p < -0.35) return 'DOWN';
  return 'FLAT';
}

/**
 * Build durable structure from Capital minutes (+ optional hours).
 * Optional prevSwing keeps levels sticky across refreshes until clearly broken.
 */
export function buildStructure(input: {
  minutes: CapitalPriceCandle[];
  hours?: CapitalPriceCandle[] | null;
  mid?: number | null;
  prev?: StructureBook | null;
}): StructureBook {
  const { minutes, hours, mid: lastMid, prev } = input;
  if (!minutes.length || minutes.length < MIN_SWING_BARS) {
    return emptyStructure(`need ≥${MIN_SWING_BARS} minute bars · have ${minutes.length}`);
  }

  const swing = detectSwingLevels(minutes);
  if (!swing.ok) return emptyStructure('swing levels not found');

  let hi = swing.high;
  let lo = swing.low;

  // Stickiness: keep previous swing until price closes beyond it with room
  if (prev?.ready && prev.swing_high > prev.swing_low) {
    const last = minutes[minutes.length - 1]!;
    const brokeHigh = last.close > prev.swing_high * 1.00015;
    const brokeLow = last.close < prev.swing_low * 0.99985;
    if (!brokeHigh && Math.abs(hi - prev.swing_high) / Math.max(prev.swing_high, 1) < 0.002) {
      hi = prev.swing_high;
    } else if (!brokeHigh && hi < prev.swing_high) {
      // don't shrink high on noise — keep remembered resistance
      hi = prev.swing_high;
    }
    if (!brokeLow && Math.abs(lo - prev.swing_low) / Math.max(prev.swing_low, 1) < 0.002) {
      lo = prev.swing_low;
    } else if (!brokeLow && lo > prev.swing_low) {
      lo = prev.swing_low;
    }
    if (brokeHigh && swing.high > prev.swing_high) hi = swing.high;
    if (brokeLow && swing.low < prev.swing_low) lo = swing.low;
  }

  const midZ = (hi + lo) / 2;
  const span = Math.max(hi - lo, Math.abs(midZ) * 1e-9);
  const px =
    lastMid != null && Number.isFinite(lastMid)
      ? lastMid
      : minutes[minutes.length - 1]!.close;
  const eps = edgeEps(px, span);
  const near_high = px >= hi - eps;
  const near_low = px <= lo + eps;
  let bias: StructureBook['bias'] = 'INSIDE';
  if (px > midZ + span * 0.1) bias = 'ABOVE';
  else if (px < midZ - span * 0.1) bias = 'BELOW';

  const hb = hourBiasFrom(hours);

  return {
    ready: true,
    swing_high: hi,
    swing_low: lo,
    mid: midZ,
    span,
    bias,
    near_high,
    near_low,
    hour_bias: hb,
    bar_count: minutes.length,
    detail: `swing H${hi.toFixed(2)} L${lo.toFixed(2)} · ${bias} · 1h ${hb} · 1m×${minutes.length}`,
    updated_at: new Date().toISOString(),
  };
}

function persistence(minutes: CapitalPriceCandle[], n = 12): number {
  const slice = minutes.slice(-n);
  const bodies = slice.map((c) => (c.close - c.open) / Math.max(Math.abs(c.open), 1e-9));
  return mean(bodies.map((v) => (v > 0.00015 ? 1 : v < -0.00015 ? -1 : 0)));
}

/** Local impulse from last ~8 minutes — dumps/rallies even mid an old wide swing. */
function recentImpulse(minutes: CapitalPriceCandle[]): 'UP' | 'DOWN' | null {
  const slice = minutes.slice(-8);
  if (slice.length < 5) return null;
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const pers = persistence(slice, slice.length);
  const net = last.close - first.open;
  const thr = Math.max(Math.abs(first.open) * 0.0007, 2.5);
  if (pers <= -0.35 && net <= -thr) return 'DOWN';
  if (pers >= 0.35 && net >= thr) return 'UP';
  return null;
}

function rawSetupFromStructure(
  structure: StructureBook,
  minutes: CapitalPriceCandle[]
): Omit<MarketSetup, 'confirm' | 'updated_at'> {
  if (!structure.ready || minutes.length < MIN_SWING_BARS) {
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: structure.swing_high,
      swing_low: structure.swing_low,
      reason: structure.detail || 'structure not ready',
    };
  }

  const last = minutes[minutes.length - 1]!;
  const hi = structure.swing_high;
  const lo = structure.swing_low;
  const pers = persistence(minutes);
  const closedAbove = last.close > hi;
  const closedBelow = last.close < lo;
  const pokeAbove = minutes.slice(-6).some((c) => c.high > hi && c.close <= hi);
  const pokeBelow = minutes.slice(-6).some((c) => c.low < lo && c.close >= lo);

  // FAILED_BREAK — poke beyond swing then close back inside (multi-minute)
  if (pokeAbove && last.close <= hi && last.close >= lo && last.close < last.open) {
    return {
      kind: 'FAILED_BREAK',
      side: 'SELL',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FAILED_BREAK at swing high ${hi.toFixed(2)} → FADE SELL`,
    };
  }
  if (pokeBelow && last.close >= lo && last.close <= hi && last.close > last.open) {
    return {
      kind: 'FAILED_BREAK',
      side: 'BUY',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FAILED_BREAK at swing low ${lo.toFixed(2)} → FADE BUY`,
    };
  }

  // BREAKOUT — close outside swing with persistence
  if (closedAbove && pers > 0.2 && last.close > last.open) {
    return {
      kind: 'BREAKOUT',
      side: 'BUY',
      playbook: 'SCALP',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `BREAKOUT above ${hi.toFixed(2)} → BUY`,
    };
  }
  if (closedBelow && pers < -0.2 && last.close < last.open) {
    return {
      kind: 'BREAKOUT',
      side: 'SELL',
      playbook: 'SCALP',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `BREAKOUT below ${lo.toFixed(2)} → SELL`,
    };
  }

  // FADE at swing edges FIRST — never arm BUY at the tip / SELL at the low
  if (structure.near_high && !closedAbove) {
    return {
      kind: 'FADE',
      side: 'SELL',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FADE SELL at swing high ${hi.toFixed(2)} · no BUY at tip`,
    };
  }
  if (structure.near_low && !closedBelow) {
    return {
      kind: 'FADE',
      side: 'BUY',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FADE BUY at swing low ${lo.toFixed(2)} · no SELL at floor`,
    };
  }

  // CONTINUATION / PULLBACK in trend (hour + minute persistence) — mid/pullback only
  const trendUp =
    pers > 0.35 || structure.hour_bias === 'UP' || structure.bias === 'ABOVE';
  const trendDown =
    pers < -0.35 || structure.hour_bias === 'DOWN' || structure.bias === 'BELOW';

  if (trendUp && !closedBelow && !structure.near_high) {
    if (last.close < structure.mid && last.close > lo) {
      return {
        kind: 'PULLBACK',
        side: 'BUY',
        playbook: 'LONG',
        status: 'FORMING',
        swing_high: hi,
        swing_low: lo,
        reason: `PULLBACK in up structure · buy toward ${lo.toFixed(2)}`,
      };
    }
    if (pers > 0.4 && structure.bias === 'ABOVE' && last.close < hi - edgeEps(last.close, hi - lo)) {
      return {
        kind: 'CONTINUATION',
        side: 'BUY',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `CONTINUATION up · above mid ${structure.mid.toFixed(2)} · below tip ${hi.toFixed(2)}`,
      };
    }
  }

  if (trendDown && !closedAbove && !structure.near_low) {
    if (last.close > structure.mid && last.close < hi) {
      return {
        kind: 'PULLBACK',
        side: 'SELL',
        playbook: 'LONG',
        status: 'FORMING',
        swing_high: hi,
        swing_low: lo,
        reason: `PULLBACK in down structure · sell toward ${hi.toFixed(2)}`,
      };
    }
    if (pers < -0.4 && structure.bias === 'BELOW' && last.close > lo + edgeEps(last.close, hi - lo)) {
      return {
        kind: 'CONTINUATION',
        side: 'SELL',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `CONTINUATION down · below mid ${structure.mid.toFixed(2)} · above floor ${lo.toFixed(2)}`,
      };
    }
  }

  // Real local move mid old swing — never sit NONE while dump/rally is live
  // Still refuse tip-chase: UP impulse at/near high → already FADE; DOWN at/near low → FADE
  const imp = recentImpulse(minutes);
  const tipEps = edgeEps(last.close, Math.max(hi - lo, 1));
  if (imp === 'DOWN' && last.close > lo + tipEps) {
    return {
      kind: 'CONTINUATION',
      side: 'SELL',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `CONTINUATION SELL · local dump impulse (not mid-NONE)`,
    };
  }
  if (imp === 'UP' && last.close < hi - tipEps) {
    return {
      kind: 'CONTINUATION',
      side: 'BUY',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `CONTINUATION BUY · local rally impulse (not mid-NONE)`,
    };
  }

  return {
    kind: 'NONE',
    side: null,
    playbook: null,
    status: 'NONE',
    swing_high: hi,
    swing_low: lo,
    reason: `NONE · mid swing H${hi.toFixed(2)}/L${lo.toFixed(2)} · no edge · no impulse`,
  };
}

/**
 * Sticky setup update — never flip on a single disagreeing refresh.
 * Call only from structure refresh / closed minute path — not every quote tick.
 *
 * Hard rule: never keep a BUY sticky while the local move is still dumping
 * (and never keep SELL sticky while still rallying). That caused Client A
 * "LOOKING FOR BUY" / FAILED_BREAK hold while Gold was still falling.
 */
export function updateSetupSticky(
  prev: MarketSetup | null | undefined,
  structure: StructureBook,
  minutes: CapitalPriceCandle[]
): MarketSetup {
  const raw = rawSetupFromStructure(structure, minutes);
  const now = new Date().toISOString();
  const prevSafe = prev || emptySetup();
  const imp = recentImpulse(minutes);
  const last = minutes[minutes.length - 1];

  const same =
    prevSafe.kind === raw.kind &&
    prevSafe.side === raw.side &&
    prevSafe.playbook === raw.playbook;

  if (same) {
    const confirm = Math.min(prevSafe.confirm + 1, SETUP_CONFIRM + 2);
    const status: SetupStatus =
      raw.kind === 'NONE'
        ? 'NONE'
        : confirm >= SETUP_CONFIRM
          ? raw.status === 'FORMING'
            ? 'FORMING'
            : 'ARMED'
          : 'FORMING';
    return {
      ...raw,
      status: raw.kind === 'NONE' ? 'NONE' : status,
      confirm,
      swing_high: structure.swing_high || raw.swing_high,
      swing_low: structure.swing_low || raw.swing_low,
      updated_at: now,
    };
  }

  // Leaving NONE for a real setup is instant — do not miss dumps waiting sticky
  if (prevSafe.kind === 'NONE' && raw.kind !== 'NONE' && raw.side) {
    return {
      ...raw,
      status: raw.status === 'FORMING' ? 'FORMING' : 'ARMED',
      confirm: SETUP_CONFIRM,
      updated_at: now,
    };
  }

  // Breakout / continuation impulse arms immediately when freshly detected
  if (
    (raw.kind === 'BREAKOUT' || raw.kind === 'CONTINUATION') &&
    raw.side &&
    raw.status === 'ARMED'
  ) {
    return {
      ...raw,
      confirm: SETUP_CONFIRM,
      updated_at: now,
    };
  }

  // Dump kills sticky BUY; rally kills sticky SELL — no "holding BUY" into a fall
  const stickyBuyDead =
    prevSafe.side === 'BUY' &&
    (imp === 'DOWN' ||
      raw.side === 'SELL' ||
      (last != null &&
        prevSafe.swing_low > 0 &&
        last.close < prevSafe.swing_low - edgeEps(last.close, Math.max(structure.span, 1))));
  const stickySellDead =
    prevSafe.side === 'SELL' &&
    (imp === 'UP' ||
      raw.side === 'BUY' ||
      (last != null &&
        prevSafe.swing_high > 0 &&
        last.close > prevSafe.swing_high + edgeEps(last.close, Math.max(structure.span, 1))));

  if (stickyBuyDead || stickySellDead) {
    return {
      ...raw,
      status: raw.kind === 'NONE' ? 'NONE' : raw.status === 'FORMING' ? 'FORMING' : 'ARMED',
      confirm: raw.kind === 'NONE' ? 0 : SETUP_CONFIRM,
      reason:
        raw.reason +
        (stickyBuyDead ? ' · dropped sticky BUY (dump/adverse)' : ' · dropped sticky SELL (rally/adverse)'),
      updated_at: now,
    };
  }

  // Candidate change — need confirm; until then keep previous if it was armed
  if (prevSafe.kind !== 'NONE' && prevSafe.confirm >= SETUP_CONFIRM && raw.kind !== prevSafe.kind) {
    return {
      ...prevSafe,
      confirm: Math.max(0, prevSafe.confirm - 1),
      reason: `${prevSafe.reason} · holding (candidate ${raw.kind})`,
      updated_at: now,
    };
  }

  return {
    ...raw,
    status: raw.kind === 'NONE' ? 'NONE' : 'FORMING',
    confirm: 1,
    updated_at: now,
  };
}

/**
 * Entry trigger on CLOSED 10s only — confirms an ARMED setup.
 * Rejection/bounce at swing for FADE/FAILED_BREAK; impulse for BREAKOUT/CONTINUATION.
 */
/** Block tip-chase: BUY into swing high / SELL into swing low (except true BREAKOUT). */
export function isTipChaseEntry(setup: MarketSetup, bar: TenSecBar): boolean {
  if (!setup.side || setup.kind === 'NONE' || setup.kind === 'BREAKOUT') return false;
  const hi = setup.swing_high;
  const lo = setup.swing_low;
  if (!(hi > lo)) return false;
  const eps = edgeEps(bar.close, hi - lo);
  if (setup.side === 'BUY' && bar.close >= hi - eps * 0.65) return true;
  if (setup.side === 'SELL' && bar.close <= lo + eps * 0.65) return true;
  return false;
}

export function decideEntryFromSetup(
  setup: MarketSetup,
  bar: TenSecBar
): SetupEntry | null {
  if (setup.kind === 'NONE' || setup.status !== 'ARMED' || !setup.side || !setup.playbook) {
    return null;
  }

  const book = setup.playbook;
  const thr = PLAYBOOK_ENTRY_BODY[book];
  const body = bodyPct(bar);
  const hi = setup.swing_high;
  const lo = setup.swing_low;
  const eps = edgeEps(bar.close, Math.max(hi - lo, 1));

  // Hard guard — the 16:00 BUY @ swing high class of mistake
  if (isTipChaseEntry(setup, bar)) {
    return null;
  }

  if (setup.kind === 'FADE' || setup.kind === 'FAILED_BREAK') {
    if (setup.side === 'BUY') {
      // Bounce: touched near low, closed up — refuse if bar still makes a new dump low
      const touched = bar.low <= lo + eps;
      const stillDumping = bar.close < bar.open || bar.low < lo - eps * 0.35;
      if (
        touched &&
        !stillDumping &&
        body >= thr * 0.85 &&
        bar.close > bar.open &&
        bar.close >= lo
      ) {
        return {
          direction: 'BUY',
          setup: setup.kind,
          playbook: book,
          reason: `ENTRY · ${setup.kind} BUY bounce @ L${lo.toFixed(2)} · ${setup.reason}`,
        };
      }
      return null;
    }
    // SELL rejection at high
    const touched = bar.high >= hi - eps;
    const stillRallying = bar.close > bar.open || bar.high > hi + eps * 0.35;
    if (
      touched &&
      !stillRallying &&
      body <= -thr * 0.85 &&
      bar.close < bar.open &&
      bar.close <= hi
    ) {
      return {
        direction: 'SELL',
        setup: setup.kind,
        playbook: book,
        reason: `ENTRY · ${setup.kind} SELL reject @ H${hi.toFixed(2)} · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'BREAKOUT') {
    if (setup.side === 'BUY' && body >= thr && bar.close > hi - eps) {
      return {
        direction: 'BUY',
        setup: 'BREAKOUT',
        playbook: book,
        reason: `ENTRY · BREAKOUT BUY · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && body <= -thr && bar.close < lo + eps) {
      return {
        direction: 'SELL',
        setup: 'BREAKOUT',
        playbook: book,
        reason: `ENTRY · BREAKOUT SELL · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'PULLBACK') {
    if (setup.side === 'BUY' && body >= thr && (bar.low <= lo + eps * 1.5 || bar.close < setup.swing_high)) {
      return {
        direction: 'BUY',
        setup: 'PULLBACK',
        playbook: book,
        reason: `ENTRY · PULLBACK BUY · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && body <= -thr && (bar.high >= hi - eps * 1.5 || bar.close > setup.swing_low)) {
      return {
        direction: 'SELL',
        setup: 'PULLBACK',
        playbook: book,
        reason: `ENTRY · PULLBACK SELL · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'CONTINUATION') {
    if (setup.side === 'BUY' && body >= thr) {
      return {
        direction: 'BUY',
        setup: 'CONTINUATION',
        playbook: book,
        reason: `ENTRY · CONTINUATION BUY · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && body <= -thr) {
      return {
        direction: 'SELL',
        setup: 'CONTINUATION',
        playbook: book,
        reason: `ENTRY · CONTINUATION SELL · ${setup.reason}`,
      };
    }
  }

  return null;
}

export function playbookFromSetup(setup: MarketSetup | null | undefined): TradePlaybook | null {
  if (!setup || setup.kind === 'NONE') return null;
  return setup.playbook;
}

export function setupCatalog() {
  return SETUP_KINDS.map((k) => ({ name: k }));
}
