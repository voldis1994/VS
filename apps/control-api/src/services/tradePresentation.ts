/** Honest trade presentation — direction only unless pipeline provides setup_type. */
export function formatTradeSide(side: 'BUY' | 'SELL' | null | undefined): string | null {
  if (side === 'BUY' || side === 'SELL') return side;
  return null;
}

/**
 * Optional classification from real pipeline fields only.
 * Never invent LONG/SCALP from direction.
 */
export function formatTradeLabel(
  side: 'BUY' | 'SELL' | null | undefined,
  setupType?: string | null
): string | null {
  const s = formatTradeSide(side);
  if (!s) return null;
  const setup = String(setupType || '')
    .trim()
    .toUpperCase();
  if (setup === 'CONTINUATION' || setup === 'PULLBACK' || setup === 'BREAKOUT') {
    return `${s} · ${setup}`;
  }
  return s;
}

/** @deprecated — do not map BUY→LONG / SELL→SCALP */
export function mapTradeType(side: 'BUY' | 'SELL' | null | undefined): string | null {
  return formatTradeSide(side);
}
