/**
 * Mega market context — one snapshot from everything the desk already sees:
 * 30m zone, 1m buyer/seller proxy (green/red counts), story chapter, velocity,
 * expand/compress, multi-feed agreement.
 *
 * No fake news API — headlines aren't in-repo. Pressure here is candle-side
 * proxy (green vs red 1m + signed body%), not true orderflow footprint.
 */
import { readMarketStory, type MarketStory } from './marketStory.js';
import { zoneGeometry, type ZoneBand } from './structureEntry.js';
import {
  bodyPct,
  isMoving10s,
  rangePct,
  type TenSecBar,
} from './tenSecondOhlc.js';
import type { MultiFeedPrice } from './robotReader.js';

export type MarketContextSnapshot = {
  at_ms: number;
  regime: string | null;
  zone: {
    pos: number;
    band: ZoneBand | string;
    width: number;
  } | null;
  story: {
    chapter: string;
    allow: string;
    red_1m: number;
    green_1m: number;
    swing: string;
    conf: number;
    net_pts: number;
  } | null;
  /** Buyer/seller proxy from closed 1m colors + last 10s body */
  pressure: {
    green_1m: number;
    red_1m: number;
    green_share: number;
    last_body_sign: -1 | 0 | 1;
    last_body_pct: number;
    ticks: number;
  };
  velocity: {
    last_body_pct: number;
    avg_range_pct: number;
    expanding: boolean;
    compressed: boolean;
    moving: boolean;
  };
  feed: {
    contributing: number;
    agreement: string;
  } | null;
  /** One-line for ticks / auto-cal */
  summary: string;
};

/** Compact fields persisted on SessionTrade for outcome learning. */
export type MarketContextCompact = {
  chapter: string | null;
  zone_band: string | null;
  green_share: number;
  expanding: boolean;
  feed_agreement: string | null;
  body_pct: number;
};

export function compactMarketContext(
  snap: MarketContextSnapshot | null | undefined
): MarketContextCompact | null {
  if (!snap) return null;
  return {
    chapter: snap.story?.chapter ?? null,
    zone_band: snap.zone?.band != null ? String(snap.zone.band) : null,
    green_share: snap.pressure.green_share,
    expanding: snap.velocity.expanding,
    feed_agreement: snap.feed?.agreement ?? null,
    body_pct: snap.velocity.last_body_pct,
  };
}

function lastBodySign(bar: TenSecBar | null | undefined): -1 | 0 | 1 {
  if (!bar) return 0;
  const d = bar.close - bar.open;
  if (Math.abs(d) < 1e-12) return 0;
  return d > 0 ? 1 : -1;
}

/**
 * Build live mega-context from the robot's 10s book + optional multi-feed.
 */
export function buildMarketContext(
  closedBars: TenSecBar[] | null | undefined,
  regime?: string | null,
  multiFeed?: MultiFeedPrice | null
): MarketContextSnapshot {
  const bars = closedBars || [];
  const last = bars.length ? bars[bars.length - 1]! : null;
  const story: MarketStory | null = bars.length ? readMarketStory(bars) : null;
  const zone = bars.length ? zoneGeometry(bars) : null;

  const green = story?.green_1m ?? 0;
  const red = story?.red_1m ?? 0;
  const colored = green + red;
  const greenShare = colored > 0 ? green / colored : 0.5;

  const lastBody = last ? bodyPct(last) : 0;
  const recent = bars.slice(-12);
  const ranges = recent.map((b) => Math.abs(rangePct(b))).filter((x) => Number.isFinite(x));
  const avgRange =
    ranges.length > 0 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0;
  const lastRange = last ? Math.abs(rangePct(last)) : 0;
  const expanding = avgRange > 0 && lastRange > avgRange * 1.35;
  const compressed = avgRange > 0 && lastRange < avgRange * 0.65;

  const feed =
    multiFeed != null
      ? {
          contributing: multiFeed.contributing ?? 0,
          agreement: String(multiFeed.agreement || 'NONE'),
        }
      : null;

  const summaryParts = [
    story?.chapter || 'NO_STORY',
    zone ? `zone ${zone.band}` : 'zone —',
    `G${green}/R${red}`,
    expanding ? 'EXPAND' : compressed ? 'COMPRESS' : 'STEADY',
    feed ? `feed ${feed.agreement}` : 'feed —',
  ];

  return {
    at_ms: Date.now(),
    regime: regime ? String(regime) : null,
    zone: zone
      ? { pos: zone.pos, band: zone.band, width: zone.width }
      : null,
    story: story
      ? {
          chapter: story.chapter,
          allow: story.allow,
          red_1m: story.red_1m,
          green_1m: story.green_1m,
          swing: story.swing,
          conf: story.confidence,
          net_pts: story.net_pts,
        }
      : null,
    pressure: {
      green_1m: green,
      red_1m: red,
      green_share: greenShare,
      last_body_sign: lastBodySign(last),
      last_body_pct: lastBody,
      ticks: last?.ticks ?? 0,
    },
    velocity: {
      last_body_pct: lastBody,
      avg_range_pct: avgRange,
      expanding,
      compressed,
      moving: isMoving10s(last),
    },
    feed,
    summary: summaryParts.join(' · '),
  };
}

/** True when 30m story fights the open side (knife / wrong allow). */
export function storyFightsSide(
  storyAllow: string | null | undefined,
  openSide: 'BUY' | 'SELL'
): boolean {
  const a = String(storyAllow || '').toUpperCase();
  if (!a || a === 'BOTH' || a === 'NONE') return false;
  if (openSide === 'BUY') return a === 'SELL';
  return a === 'BUY';
}

/** True when pressure (green share) fights open side. */
export function pressureFightsSide(
  greenShare: number,
  openSide: 'BUY' | 'SELL'
): boolean {
  if (openSide === 'BUY') return greenShare < 0.38;
  return greenShare > 0.62;
}
