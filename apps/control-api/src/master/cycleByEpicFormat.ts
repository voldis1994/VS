/** Dashboard/embed formatter for multi-epic cycle evidence. */

export type CycleByEpicRow = {
  at?: string;
  market_setup?: {
    kind?: string;
    side?: string | null;
    status?: string;
    reason?: string;
    confirm?: number;
  } | null;
  last_market?: { ok?: boolean; quality?: number } | null;
  decision_kind?: string | null;
  buy_score?: number | null;
  sell_score?: number | null;
};

/** Compact one-line summary: `GOLD:ARMED BUY · WAIT · SILVER:WATCH · BLOCK` */
export function formatCyclesByEpicDetail(
  cycles: Record<string, CycleByEpicRow> | null | undefined,
  activeEpic?: string | null
): string {
  if (!cycles || typeof cycles !== 'object') return '—';
  const keys = Object.keys(cycles).sort((a, b) => a.localeCompare(b));
  if (!keys.length) return '—';
  const active = String(activeEpic || '')
    .trim()
    .toUpperCase();
  const parts = keys.map((epic) => {
    const row = cycles[epic]!;
    const setup = row.market_setup;
    const setupBit = setup
      ? `${setup.status || '?'}${setup.side ? ` ${setup.side}` : ''}`
      : 'no-setup';
    const dec = row.decision_kind || '—';
    const mark = active && epic.toUpperCase() === active ? '*' : '';
    return `${mark}${epic}:${setupBit} · ${dec}`;
  });
  return parts.join(' · ').slice(0, 240);
}

export function cyclesByEpicTone(
  cycles: Record<string, CycleByEpicRow> | null | undefined
): 'ok' | 'warn' | '' {
  if (!cycles) return '';
  const n = Object.keys(cycles).length;
  if (n >= 2) return 'ok';
  if (n === 1) return 'warn';
  return '';
}
