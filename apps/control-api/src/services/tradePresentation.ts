/** Presentation mapping only — does not change trading decisions. */
export function mapTradeType(side: 'BUY' | 'SELL' | null | undefined): string | null {
  if (side === 'BUY') return 'BUY LONG';
  if (side === 'SELL') return 'SELL SCALP';
  return null;
}
