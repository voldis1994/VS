/**
 * Late-move gate — port of Capital.com desk isLateMoveOnOneMinute.
 * Blocks chasing a bar that already ran hard in trade direction.
 */
import type { Bar } from './types.js';

export function isLateMoveOnBars(
  direction: 'BUY' | 'SELL',
  bars: Bar[] | null | undefined
): boolean {
  if (!bars?.length) return false;
  const last = bars[bars.length - 1]!;
  const open = Number(last.open);
  const close = Number(last.close);
  if (![open, close].every((n) => Number.isFinite(n))) return false;
  const mid = Math.max(Math.abs(open), 1e-9);
  const move = close - open;
  const thr = Math.max(mid * 0.0025, 0.12);
  if (direction === 'BUY' && move >= thr) return true;
  if (direction === 'SELL' && move <= -thr) return true;
  return false;
}
