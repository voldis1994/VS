/**
 * Instrument / broker trading-session metadata for gap classification.
 * Without proven session break → UNKNOWN (NOT_READY).
 */

export type SessionKind = 'crypto_24x7' | 'fx' | 'indices' | 'metals' | 'energy' | 'unknown';

export type TradingSessionMeta = {
  kind: SessionKind;
  /** Max expected closed-market gap (ms). null = none allowed (24x7). */
  max_session_gap_ms: number | null;
  /** Optional weekday closed ranges — future broker calendar hook */
  detail?: string;
};

/** Category → session defaults. Prefer broker hours when available. */
export function sessionMetaForCategory(category: string | null | undefined): TradingSessionMeta {
  const c = String(category || '')
    .trim()
    .toLowerCase();
  if (c === 'crypto') {
    return { kind: 'crypto_24x7', max_session_gap_ms: null, detail: '24/7 · no session gaps' };
  }
  if (c === 'fx') {
    // Typical FX weekend Fri 21:00–Sun 22:00 UTC ≈ 48–50h — only when kind=fx is known
    return {
      kind: 'fx',
      max_session_gap_ms: 72 * 3_600_000,
      detail: 'FX weekend-capable',
    };
  }
  if (c === 'indices' || c === 'metals' || c === 'energy') {
    // Daily cash session break — only when category known
    return {
      kind: c as SessionKind,
      max_session_gap_ms: 20 * 3_600_000,
      detail: `${c} daily session break`,
    };
  }
  return { kind: 'unknown', max_session_gap_ms: null, detail: 'UNKNOWN session metadata' };
}

export function sessionMetaForEpic(
  epic: string | null | undefined,
  categoryHint?: string | null
): TradingSessionMeta {
  const e = String(epic || '').toUpperCase();
  if (/BTC|ETH|CRYPTO/.test(e) || categoryHint === 'crypto') {
    return sessionMetaForCategory('crypto');
  }
  if (categoryHint) return sessionMetaForCategory(categoryHint);
  if (/XAU|XAG|GOLD|SILVER/.test(e)) return sessionMetaForCategory('metals');
  if (/OIL|BRENT|WTI/.test(e)) return sessionMetaForCategory('energy');
  if (/US500|US100|US30|GER40|UK100|JP225|NASDAQ|SPX|DAX/.test(e)) {
    return sessionMetaForCategory('indices');
  }
  if (/USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD/.test(e) && e.length <= 12) {
    return sessionMetaForCategory('fx');
  }
  return sessionMetaForCategory(null);
}

/**
 * Classify gap using session metadata.
 * Heuristic weekend/daily ranges WITHOUT metadata are forbidden.
 */
export function classifyBarGapWithSession(
  prevMs: number,
  nextMs: number,
  stepMs: number,
  session: TradingSessionMeta | null | undefined
): 'none' | 'session' | 'missing' | 'unknown' {
  const delta = nextMs - prevMs;
  if (!(delta > 0) || !(stepMs > 0)) return 'unknown';
  if (delta <= stepMs * 1.5) return 'none';

  const meta = session ?? { kind: 'unknown' as const, max_session_gap_ms: null };

  // 24/7 markets: any excess gap is missing data
  if (meta.kind === 'crypto_24x7' || meta.max_session_gap_ms == null) {
    if (meta.kind === 'crypto_24x7') return 'missing';
    // UNKNOWN session metadata → cannot prove session break
    return 'unknown';
  }

  // Known session instrument: gap within max_session_gap and clearly larger than a few steps
  if (delta <= meta.max_session_gap_ms && delta > stepMs * 3) {
    return 'session';
  }
  if (delta > meta.max_session_gap_ms) return 'missing';
  return 'missing';
}
