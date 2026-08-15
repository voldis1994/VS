/** Trade labels from real regime/setup classification — never BUY=LONG / SELL=SCALP. */
import { styleFromClassification } from './regimes.js';

export function formatTradeSide(side: 'BUY' | 'SELL' | null | undefined): string | null {
  if (side === 'BUY' || side === 'SELL') return side;
  return null;
}

/**
 * Original Client Panel names when classification exists:
 * BUY LONG | SELL LONG | BUY SCALP | SELL SCALP
 * Otherwise honest direction only.
 */
export function formatTradeLabel(
  side: 'BUY' | 'SELL' | null | undefined,
  setupType?: string | null,
  regime?: string | null
): string | null {
  const s = formatTradeSide(side);
  if (!s) return null;
  const style = styleFromClassification(regime, setupType, s);
  if (style) return `${s} ${style}`;
  const setup = String(setupType || '').trim().toUpperCase();
  if (setup === 'CONTINUATION' || setup === 'PULLBACK' || setup === 'BREAKOUT') {
    return `${s} · ${setup}`;
  }
  return s;
}

export function mapTradeType(
  side: 'BUY' | 'SELL' | null | undefined,
  setupType?: string | null,
  regime?: string | null
): string | null {
  return formatTradeLabel(side, setupType, regime);
}
