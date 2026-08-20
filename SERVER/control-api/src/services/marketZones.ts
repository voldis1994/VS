/**
 * Swing demand/supply zones for Gold 10s MAIN path.
 * Zones are bands around swing highs/lows — not single ticks, not mid-range noise.
 */
import type { TenSecBar } from './tenSecondOhlc.js';

export type ZoneSide = 'DEMAND' | 'SUPPLY';

export type MarketZone = {
  side: ZoneSide;
  /** Band low (inclusive). */
  lo: number;
  /** Band high (inclusive). */
  hi: number;
  /** Pivot price (swing low for demand, swing high for supply). */
  pivot: number;
  /** Closed-bar index of the swing (in the lookback window). */
  bar_index: number;
  touches: number;
};

export type ZoneMap = {
  demand: MarketZone[];
  supply: MarketZone[];
  mid: number | null;
};

const LOOKBACK = 24;
const MAX_ZONES = 4;

function findSwingHighs(bars: TenSecBar[]): { idx: number; val: number }[] {
  const out: { idx: number; val: number }[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const h = bars[i]!.high;
    if (h >= bars[i - 1]!.high && h >= bars[i + 1]!.high) out.push({ idx: i, val: h });
  }
  return out;
}

function findSwingLows(bars: TenSecBar[]): { idx: number; val: number }[] {
  const out: { idx: number; val: number }[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const l = bars[i]!.low;
    if (l <= bars[i - 1]!.low && l <= bars[i + 1]!.low) out.push({ idx: i, val: l });
  }
  return out;
}

/** Half-width of a zone in price units (Gold ~0.8–1.5 pts). */
export function zoneHalfWidth(price: number): number {
  const abs = Math.max(Math.abs(price), 1e-9);
  if (abs >= 1000) return Math.max(0.8, abs * 0.00022);
  if (abs >= 100) return Math.max(0.15, abs * 0.0004);
  return Math.max(0.0005, abs * 0.0005);
}

function countTouches(
  side: ZoneSide,
  lo: number,
  hi: number,
  bars: TenSecBar[],
  pivotIdx: number
): number {
  let n = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i === pivotIdx) continue;
    const b = bars[i]!;
    if (side === 'DEMAND') {
      if (b.low <= hi && b.low >= lo - (hi - lo) * 0.25) n += 1;
    } else if (b.high >= lo && b.high <= hi + (hi - lo) * 0.25) {
      n += 1;
    }
  }
  return n;
}

/** Build recent demand (swing lows) and supply (swing highs) zones. */
export function buildMarketZones(bars: TenSecBar[] | null | undefined): ZoneMap {
  const w = (bars || []).filter((b) => b && Number.isFinite(b.close)).slice(-LOOKBACK);
  if (w.length < 6) {
    return { demand: [], supply: [], mid: null };
  }
  const mid = w[w.length - 1]!.close;
  const half = zoneHalfWidth(mid);

  const lows = findSwingLows(w);
  const highs = findSwingHighs(w);

  const demand: MarketZone[] = lows
    .slice(-MAX_ZONES)
    .map((s) => {
      const lo = s.val - half;
      const hi = s.val + half;
      return {
        side: 'DEMAND' as const,
        lo,
        hi,
        pivot: s.val,
        bar_index: s.idx,
        touches: countTouches('DEMAND', lo, hi, w, s.idx),
      };
    })
    .sort((a, b) => b.pivot - a.pivot); // nearest below first when filtering

  const supply: MarketZone[] = highs
    .slice(-MAX_ZONES)
    .map((s) => {
      const lo = s.val - half;
      const hi = s.val + half;
      return {
        side: 'SUPPLY' as const,
        lo,
        hi,
        pivot: s.val,
        bar_index: s.idx,
        touches: countTouches('SUPPLY', lo, hi, w, s.idx),
      };
    })
    .sort((a, b) => a.pivot - b.pivot);

  return { demand, supply, mid };
}

export function priceInZone(price: number, zone: MarketZone): boolean {
  return Number.isFinite(price) && price >= zone.lo && price <= zone.hi;
}

export function barTouchesZone(bar: TenSecBar, zone: MarketZone): boolean {
  return bar.low <= zone.hi && bar.high >= zone.lo;
}

/** Soft approach: wick/close within half a band of the zone (Gold 10s noise). */
export function barNearZone(bar: TenSecBar, zone: MarketZone): boolean {
  if (barTouchesZone(bar, zone) || priceInZone(bar.close, zone)) return true;
  const soft = (zone.hi - zone.lo) * 0.5;
  return bar.low <= zone.hi + soft && bar.high >= zone.lo - soft;
}

/** Nearest demand at or below price. */
export function nearestDemandBelow(map: ZoneMap, price: number): MarketZone | null {
  const cands = map.demand.filter((z) => z.hi <= price + (z.hi - z.lo) || priceInZone(price, z));
  if (!cands.length) {
    // Allow current price sitting in a demand band
    const inBand = map.demand.filter((z) => priceInZone(price, z) || price >= z.lo);
    return inBand.sort((a, b) => b.pivot - a.pivot)[0] ?? null;
  }
  return cands.sort((a, b) => b.pivot - a.pivot)[0] ?? null;
}

/** Nearest supply at or above price. */
export function nearestSupplyAbove(map: ZoneMap, price: number): MarketZone | null {
  const cands = map.supply.filter((z) => z.lo >= price - (z.hi - z.lo) || priceInZone(price, z));
  if (!cands.length) {
    const inBand = map.supply.filter((z) => priceInZone(price, z) || price <= z.hi);
    return inBand.sort((a, b) => a.pivot - b.pivot)[0] ?? null;
  }
  return cands.sort((a, b) => a.pivot - b.pivot)[0] ?? null;
}

export function demandZonesBelow(map: ZoneMap, price: number): MarketZone[] {
  return map.demand
    .filter((z) => z.pivot < price || priceInZone(price, z))
    .sort((a, b) => b.pivot - a.pivot);
}

export function supplyZonesAbove(map: ZoneMap, price: number): MarketZone[] {
  return map.supply
    .filter((z) => z.pivot > price || priceInZone(price, z))
    .sort((a, b) => a.pivot - b.pivot);
}

/**
 * Entry permission: setup must interact with a real zone.
 * - PULLBACK BUY → demand
 * - PULLBACK/CONTINUATION SELL → supply
 * - BREAKOUT → close beyond zone or retest of broken zone
 * - RANGE_REJECTION / FADE / REVERSAL → edge zone
 */
export function zoneAllowsEntry(input: {
  direction: 'BUY' | 'SELL';
  setup?: string | null;
  bar: TenSecBar;
  zones: ZoneMap;
}): { ok: boolean; reason: string; zone: MarketZone | null } {
  const setup = String(input.setup || '')
    .trim()
    .toUpperCase();
  const { bar, direction, zones } = input;
  const px = bar.close;

  if (!zones.demand.length && !zones.supply.length) {
    return { ok: false, reason: 'NO_ZONE · not enough swing structure', zone: null };
  }

  if (setup.includes('BREAKOUT')) {
    if (direction === 'BUY') {
      const broken = zones.supply.find((z) => bar.close > z.hi && bar.low <= z.hi + (z.hi - z.lo));
      const retest = zones.supply.find((z) => barTouchesZone(bar, z) && bar.close >= z.lo);
      const z = broken || retest || null;
      if (!z) return { ok: false, reason: 'NO_ZONE · BREAKOUT BUY needs supply break/retest', zone: null };
      return { ok: true, reason: `ZONE · BREAKOUT BUY @ supply ${z.pivot.toFixed(2)}`, zone: z };
    }
    const broken = zones.demand.find((z) => bar.close < z.lo && bar.high >= z.lo - (z.hi - z.lo));
    const retest = zones.demand.find((z) => barTouchesZone(bar, z) && bar.close <= z.hi);
    const z = broken || retest || null;
    if (!z) return { ok: false, reason: 'NO_ZONE · BREAKOUT SELL needs demand break/retest', zone: null };
    return { ok: true, reason: `ZONE · BREAKOUT SELL @ demand ${z.pivot.toFixed(2)}`, zone: z };
  }

  if (
    setup.includes('RANGE_REJECTION') ||
    setup.includes('FADE') ||
    setup.includes('REVERSAL') ||
    setup.includes('FAILED_BREAKOUT')
  ) {
    if (direction === 'SELL') {
      const z = zones.supply.find((z) => barNearZone(bar, z)) ?? nearestSupplyAbove(zones, px);
      if (!z || !barNearZone(bar, z)) {
        return { ok: false, reason: 'NO_ZONE · rejection SELL needs supply touch', zone: null };
      }
      return { ok: true, reason: `ZONE · rejection SELL @ supply ${z.pivot.toFixed(2)}`, zone: z };
    }
    const z = zones.demand.find((z) => barNearZone(bar, z)) ?? nearestDemandBelow(zones, px);
    if (!z || !barNearZone(bar, z)) {
      return { ok: false, reason: 'NO_ZONE · rejection BUY needs demand touch', zone: null };
    }
    return { ok: true, reason: `ZONE · rejection BUY @ demand ${z.pivot.toFixed(2)}`, zone: z };
  }

  // PULLBACK / CONTINUATION / default structure entries
  if (direction === 'BUY') {
    const z =
      zones.demand.find((z) => barNearZone(bar, z)) ?? nearestDemandBelow(zones, px);
    if (!z || !barNearZone(bar, z)) {
      return { ok: false, reason: 'NO_ZONE · BUY pullback needs demand zone', zone: null };
    }
    return { ok: true, reason: `ZONE · BUY @ demand ${z.pivot.toFixed(2)}`, zone: z };
  }

  const z = zones.supply.find((z) => barNearZone(bar, z)) ?? nearestSupplyAbove(zones, px);
  if (!z || !barNearZone(bar, z)) {
    return { ok: false, reason: 'NO_ZONE · SELL needs supply zone', zone: null };
  }
  return { ok: true, reason: `ZONE · SELL @ supply ${z.pivot.toFixed(2)}`, zone: z };
}

export type ZoneExitAction = 'HOLD' | 'PARTIAL' | 'FULL';

export type ZoneExitDecision = {
  action: ZoneExitAction;
  reason: string;
  /** Target zone that triggered (if any). */
  zone: MarketZone | null;
  /** Fraction of original lot to close on PARTIAL (0.5 = half). */
  close_fraction: number;
};

/**
 * Manage exit by zones:
 * - First opposing zone hit → PARTIAL (scale out half)
 * - Next opposing zone / already scaled → can FULL at second target
 * - Trend reverse into entry-side zone against us → FULL
 */
export function decideZoneManageExit(input: {
  side: 'BUY' | 'SELL';
  entry: number;
  mid: number;
  bars: TenSecBar[] | null | undefined;
  zones: ZoneMap;
  partial_done: boolean;
  /** Favorable move in price points (same units as robot UPL). */
  upl: number;
}): ZoneExitDecision {
  const { side, entry, mid, zones, partial_done, upl } = input;
  const last = (input.bars || []).filter((b) => b && Number.isFinite(b.close)).slice(-1)[0];

  if (side === 'BUY') {
    const targets = supplyZonesAbove(zones, entry).filter((z) => z.pivot > entry);
    const first = targets[0] ?? null;
    const second = targets[1] ?? null;
    const entryDemand =
      zones.demand.find((z) => priceInZone(entry, z)) ?? nearestDemandBelow(zones, entry);

    // Reverse: back in entry demand with adverse close after we had progress, or deep giveback.
    if (
      entryDemand &&
      last &&
      priceInZone(mid, entryDemand) &&
      last.close < last.open &&
      (partial_done || upl < 0)
    ) {
      return {
        action: 'FULL',
        reason: `ZONE FULL · BUY reverse into demand ${entryDemand.pivot.toFixed(2)}`,
        zone: entryDemand,
        close_fraction: 1,
      };
    }

    if (!partial_done && first && (mid >= first.lo || (last && barTouchesZone(last, first)))) {
      if (upl > 0) {
        return {
          action: 'PARTIAL',
          reason: `ZONE PARTIAL · BUY hit supply ${first.pivot.toFixed(2)} · scale half`,
          zone: first,
          close_fraction: 0.5,
        };
      }
    }

    if (partial_done && second && mid >= second.lo) {
      if (upl > 0) {
        return {
          action: 'FULL',
          reason: `ZONE FULL · BUY second supply ${second.pivot.toFixed(2)}`,
          zone: second,
          close_fraction: 1,
        };
      }
    }

    // After partial: if price fails and falls back through first target the wrong way → full.
    if (partial_done && first && mid < first.lo - (first.hi - first.lo) && upl <= 0) {
      return {
        action: 'FULL',
        reason: `ZONE FULL · BUY failed after partial · back below ${first.pivot.toFixed(2)}`,
        zone: first,
        close_fraction: 1,
      };
    }

    return { action: 'HOLD', reason: 'ZONE HOLD · wait next supply / reverse', zone: first, close_fraction: 0 };
  }

  // SELL
  const targets = demandZonesBelow(zones, entry).filter((z) => z.pivot < entry);
  const first = targets[0] ?? null;
  const second = targets[1] ?? null;
  const entrySupply =
    zones.supply.find((z) => priceInZone(entry, z)) ?? nearestSupplyAbove(zones, entry);

  if (
    entrySupply &&
    last &&
    priceInZone(mid, entrySupply) &&
    last.close > last.open &&
    (partial_done || upl < 0)
  ) {
    return {
      action: 'FULL',
      reason: `ZONE FULL · SELL reverse into supply ${entrySupply.pivot.toFixed(2)}`,
      zone: entrySupply,
      close_fraction: 1,
    };
  }

  if (!partial_done && first && (mid <= first.hi || (last && barTouchesZone(last, first)))) {
    if (upl > 0) {
      return {
        action: 'PARTIAL',
        reason: `ZONE PARTIAL · SELL hit demand ${first.pivot.toFixed(2)} · scale half`,
        zone: first,
        close_fraction: 0.5,
      };
    }
  }

  if (partial_done && second && mid <= second.hi) {
    if (upl > 0) {
      return {
        action: 'FULL',
        reason: `ZONE FULL · SELL second demand ${second.pivot.toFixed(2)}`,
        zone: second,
        close_fraction: 1,
      };
    }
  }

  if (partial_done && first && mid > first.hi + (first.hi - first.lo) && upl <= 0) {
    return {
      action: 'FULL',
      reason: `ZONE FULL · SELL failed after partial · back above ${first.pivot.toFixed(2)}`,
      zone: first,
      close_fraction: 1,
    };
  }

  return { action: 'HOLD', reason: 'ZONE HOLD · wait next demand / reverse', zone: first, close_fraction: 0 };
}

/** Half lot for scale-out; respects broker-ish 0.01 min when original >= 0.02. */
export function partialCloseSize(originalLot: number): number {
  if (!(originalLot > 0) || !Number.isFinite(originalLot)) return 0;
  const half = originalLot / 2;
  const rounded = Math.round(half * 100) / 100;
  if (originalLot >= 0.02 && rounded < 0.01) return 0.01;
  if (rounded <= 0 || rounded >= originalLot) return 0;
  return rounded;
}
