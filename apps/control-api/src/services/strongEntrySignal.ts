/**
 * Strong-signal gate for Soft OFF regimes.
 * Soft OFF blocks knife/chop; strong playbook+story+HTF may still enter.
 */
export type StrongEntryHtf = {
  tf30?: string | null;
  tf15?: string | null;
  tf5?: string | null;
};

export function isStrongEntrySignal(opts: {
  direction: 'BUY' | 'SELL';
  setup?: string | null;
  storyAllow?: string | null;
  storyChapter?: string | null;
  storyConf?: number | null;
  htf?: StrongEntryHtf | null;
}): boolean {
  const dir = opts.direction;
  const allow = String(opts.storyAllow || '').toUpperCase();
  if (allow !== dir && allow !== 'BOTH') return false;

  const want = dir === 'BUY' ? 'UP' : 'DOWN';
  const h = opts.htf || {};
  const tfs = [h.tf30, h.tf15, h.tf5].map((x) => String(x || '').toUpperCase());
  const aligned = tfs.filter((t) => t === want).length;
  const setup = String(opts.setup || '').toUpperCase();
  const ch = String(opts.storyChapter || '').toUpperCase();
  const conf = Number(opts.storyConf) || 0;

  // Structure break / fail — strong even with 1 HTF agree
  if (
    setup === 'BREAKOUT' &&
    (ch.includes('BREAK') || ch.startsWith('FAILED') || aligned >= 1)
  ) {
    return true;
  }
  // Trend resume / pullback — need HTF stack
  if ((setup === 'PULLBACK' || setup === 'CONTINUATION') && aligned >= 2) {
    return true;
  }
  // Fade only after reject / failed break + HTF (not tip-chase chop)
  if (
    setup === 'FADE' &&
    (ch === 'EXHAUST_HI' ||
      ch === 'EXHAUST_LO' ||
      ch.startsWith('FAILED') ||
      ch === 'BOUNCE_IN_SELL' ||
      ch === 'DIP_IN_RALLY') &&
    aligned >= 2
  ) {
    return true;
  }
  // High-confidence story + HTF, non-fade
  if (conf >= 0.7 && aligned >= 2 && setup !== 'FADE') {
    return true;
  }
  return false;
}
