/**
 * Persist last OHLC + quote so restart manage is not blind when broker
 * history is slow/unavailable. Quote is only reused when still fresh.
 * Also embeds into master_state.json operator_meta so DualPersist / sidecar
 * wipe cannot leave manage blind while positions recover from PG.
 *
 * Hour bars (desk hour_bias structure) persist beside minute bars so restart
 * does not wait on network for 1h OHLC.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson } from './atomicIo.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';
import type { Bar, Quote } from './types.js';

function finiteBar(b: Bar | null | undefined): boolean {
  return !!(
    b &&
    Number.isFinite(b.open) &&
    Number.isFinite(b.high) &&
    Number.isFinite(b.low) &&
    Number.isFinite(b.close)
  );
}

export type MarketCacheState = {
  epic: string;
  bars: Bar[];
  quote: Quote | null;
  /** Desk 1h structure OHLC (hour_bias) — optional, survives restart. */
  hour_bars?: Bar[];
  hour_bars_detail?: string | null;
  structure_seed_source?: string | null;
  saved_at_ms: number;
};

function cachePath(root: string) {
  return join(root, 'market_cache.json');
}

export function marketCacheDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    join(process.cwd(), '.master-state')
  );
}

/** Embed compact market_cache into master_state operator_meta (best-effort). */
export function embedMarketCacheInOperatorMeta(
  state: MarketCacheState,
  root?: string
): boolean {
  return embedOperatorMetaPatch({ market_cache: state }, root);
}

export function saveMarketCache(
  input: {
    epic: string;
    bars: Bar[];
    quote: Quote | null;
    hour_bars?: Bar[] | null;
    hour_bars_detail?: string | null;
    structure_seed_source?: string | null;
  },
  root?: string
): boolean {
  try {
    const dir = marketCacheDir(root);
    const bars = (input.bars || []).slice(-120).filter(finiteBar);
    const hour_bars = (input.hour_bars || []).slice(-48).filter(finiteBar);
    if (!bars.length && !input.quote && !hour_bars.length) return false;
    const state: MarketCacheState = {
      epic: input.epic,
      bars,
      quote: input.quote,
      ...(hour_bars.length ? { hour_bars } : {}),
      hour_bars_detail: input.hour_bars_detail ?? null,
      structure_seed_source: input.structure_seed_source ?? null,
      saved_at_ms: Date.now(),
    };
    atomicWriteJson(cachePath(dir), state);
    // Keep operator_meta in sync even when no position write flushes FilePersist
    embedMarketCacheInOperatorMeta(state, dir);
    return true;
  } catch {
    return false;
  }
}

export function loadMarketCache(root?: string): MarketCacheState | null {
  try {
    const path = cachePath(marketCacheDir(root));
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as MarketCacheState;
    if (!raw || !Array.isArray(raw.bars)) return null;
    const hour_bars = Array.isArray(raw.hour_bars)
      ? raw.hour_bars.filter(finiteBar)
      : [];
    return {
      epic: String(raw.epic || ''),
      bars: raw.bars.filter(finiteBar),
      quote:
        raw.quote &&
        Number.isFinite(raw.quote.mid) &&
        Number.isFinite(raw.quote.bid) &&
        Number.isFinite(raw.quote.ask)
          ? raw.quote
          : null,
      ...(hour_bars.length ? { hour_bars } : {}),
      hour_bars_detail: raw.hour_bars_detail ?? null,
      structure_seed_source: raw.structure_seed_source ?? null,
      saved_at_ms: Number(raw.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}
