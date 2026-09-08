/**
 * Persist last OHLC + quote so restart manage is not blind when broker
 * history is slow/unavailable. Quote is only reused when still fresh.
 * Also embeds into master_state.json operator_meta so DualPersist / sidecar
 * wipe cannot leave manage blind while positions recover from PG.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson } from './atomicIo.js';
import type { Bar, Quote } from './types.js';

export type MarketCacheState = {
  epic: string;
  bars: Bar[];
  quote: Quote | null;
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
  try {
    const dir = marketCacheDir(root);
    const statePath = join(dir, 'master_state.json');
    if (!existsSync(statePath)) return false;
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as {
      operator_meta?: Record<string, unknown> | null;
      [k: string]: unknown;
    };
    raw.operator_meta = {
      ...(raw.operator_meta && typeof raw.operator_meta === 'object'
        ? raw.operator_meta
        : {}),
      market_cache: state,
    };
    return atomicWriteJson(statePath, raw);
  } catch {
    return false;
  }
}

export function saveMarketCache(
  input: {
    epic: string;
    bars: Bar[];
    quote: Quote | null;
    structure_seed_source?: string | null;
  },
  root?: string
): boolean {
  try {
    const dir = marketCacheDir(root);
    const bars = (input.bars || []).slice(-120).filter(
      (b) =>
        b &&
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close)
    );
    if (!bars.length && !input.quote) return false;
    const state: MarketCacheState = {
      epic: input.epic,
      bars,
      quote: input.quote,
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
    return {
      epic: String(raw.epic || ''),
      bars: raw.bars.filter(
        (b) =>
          b &&
          Number.isFinite(b.open) &&
          Number.isFinite(b.high) &&
          Number.isFinite(b.low) &&
          Number.isFinite(b.close)
      ),
      quote:
        raw.quote &&
        Number.isFinite(raw.quote.mid) &&
        Number.isFinite(raw.quote.bid) &&
        Number.isFinite(raw.quote.ask)
          ? raw.quote
          : null,
      structure_seed_source: raw.structure_seed_source ?? null,
      saved_at_ms: Number(raw.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}
