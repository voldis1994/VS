/**
 * Trade → error/pattern analysis for the self-improve loop.
 * Window patterns are counted fresh each cycle (no lifetime += inflation).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeExitReason } from '../services/tradeLedger.js';
import {
  loadExperience,
  type BrainErrorPattern,
  type BrainExperience,
} from './experience.js';

export type AnalyzedTrade = {
  pnl_pts: number;
  exit_reason: string | null;
  direction?: 'BUY' | 'SELL' | null;
  mfe?: number;
  mae?: number;
  regime?: string | null;
  setup_type?: string | null;
  at?: string;
};

export type AnalysisResult = {
  trades: AnalyzedTrade[];
  patterns: BrainErrorPattern[];
  top_pattern: BrainErrorPattern | null;
  session_e: number;
  soft_losses: number;
  soft_sell_losses: number;
  soft_buy_losses: number;
  micro_scratches: number;
  green_not_banked: number;
  summary: string;
};

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

function readAutoCalTrades(): AnalyzedTrade[] {
  const roots = [
    path.join(repoRoot(), 'data', 'auto-calibrate-session.json'),
    path.join(repoRoot(), 'apps', 'control-api', 'data', 'auto-calibrate-session.json'),
  ];
  const dir = path.join(repoRoot(), 'data', 'auto-calibrate');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) roots.push(path.join(dir, f));
    }
  }
  const out: AnalyzedTrade[] = [];
  for (const p of roots) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
        trades?: Array<Record<string, unknown>>;
        state?: { trades?: Array<Record<string, unknown>> };
      };
      const rows = raw.trades || raw.state?.trades || [];
      for (const t of rows) {
        const pnl = Number(t.pnl_pts);
        if (!Number.isFinite(pnl)) continue;
        const dirRaw = String(t.direction || t.open_side || '').toUpperCase();
        const direction =
          dirRaw === 'BUY' || dirRaw === 'SELL' ? (dirRaw as 'BUY' | 'SELL') : null;
        out.push({
          pnl_pts: pnl,
          exit_reason: t.exit_reason != null ? String(t.exit_reason) : null,
          direction,
          mfe: Number.isFinite(Number(t.mfe)) ? Number(t.mfe) : undefined,
          mae: Number.isFinite(Number(t.mae)) ? Number(t.mae) : undefined,
          regime: t.regime != null ? String(t.regime) : null,
          setup_type: t.setup_type != null ? String(t.setup_type) : null,
          at: t.at != null ? String(t.at) : undefined,
        });
      }
    } catch {
      /* skip bad file */
    }
  }
  return out;
}

/** Fallback synthetic session when no live closes — still drives learning loop offline. */
export function syntheticLessonTrades(): AnalyzedTrade[] {
  return [
    {
      pnl_pts: -3.5,
      exit_reason: 'HardInvalidation · Soft',
      direction: 'SELL',
      mfe: 0.4,
      mae: -3.5,
      regime: 'TREND_DOWN',
    },
    {
      pnl_pts: -3.4,
      exit_reason: 'HardInvalidation · Soft',
      direction: 'SELL',
      mfe: 0.2,
      mae: -3.4,
      regime: 'TREND_DOWN',
    },
    {
      pnl_pts: 1.1,
      exit_reason: 'PeakProtection · keep≤60%',
      direction: 'SELL',
      mfe: 8.2,
      mae: -0.5,
      regime: 'RANGE',
    },
    {
      pnl_pts: -0.08,
      exit_reason: 'EXTERNAL · SCRATCH',
      direction: 'SELL',
      mfe: 0.1,
      mae: -0.08,
      regime: 'RANGE',
    },
    {
      pnl_pts: -0.11,
      exit_reason: 'StructureInvalidation',
      direction: 'BUY',
      mfe: 0.3,
      mae: -0.11,
      regime: 'RANGE',
    },
  ];
}

type Acc = { id: string; label: string; count: number; evidence: string[] };

const PATTERN_PRIORITY: Record<string, number> = {
  soft_sell_spam: 100,
  soft_buy_spam: 95,
  rr_inverted: 90,
  green_not_banked: 85,
  soft_loss: 70,
  micro_scratch: 40,
};

function bump(map: Map<string, Acc>, id: string, label: string, evidence: string): void {
  const cur = map.get(id);
  if (cur) {
    cur.count += 1;
    cur.evidence = [...cur.evidence.slice(-8), evidence].slice(-10);
  } else {
    map.set(id, { id, label, count: 1, evidence: [evidence] });
  }
}

/** Prefer specific Soft-side spam over generic soft_loss when the window shows it. */
export function pickTopPattern(
  patterns: BrainErrorPattern[],
  softSell: number,
  softBuy: number
): BrainErrorPattern | null {
  if (!patterns.length) return null;
  const byId = new Map(patterns.map((p) => [p.id, p]));
  if (softSell >= 2 && byId.has('soft_sell_spam')) return byId.get('soft_sell_spam')!;
  if (softBuy >= 2 && byId.has('soft_buy_spam')) return byId.get('soft_buy_spam')!;
  const ranked = [...patterns].sort((a, b) => {
    const pa = PATTERN_PRIORITY[a.id] ?? 10;
    const pb = PATTERN_PRIORITY[b.id] ?? 10;
    return pb - pa || b.count - a.count || b.last_seen.localeCompare(a.last_seen);
  });
  return ranked[0] || null;
}

export function analyzeTrades(
  inputTrades?: AnalyzedTrade[] | null,
  _expIn?: BrainExperience
): AnalysisResult {
  void _expIn;
  let trades = inputTrades && inputTrades.length ? [...inputTrades] : readAutoCalTrades();
  if (!trades.length) trades = syntheticLessonTrades();

  const window = trades.slice(-24);
  const session_e =
    window.reduce((a, t) => a + t.pnl_pts, 0) / Math.max(1, window.length);

  let soft_losses = 0;
  let soft_sell_losses = 0;
  let soft_buy_losses = 0;
  let micro_scratches = 0;
  let green_not_banked = 0;
  const acc = new Map<string, Acc>();
  const now = new Date().toISOString();

  for (const t of window) {
    const reason = summarizeExitReason(t.exit_reason);
    const soft = /HardInvalidation/i.test(reason);
    const scratch =
      Math.abs(t.pnl_pts) < 0.5 ||
      /SCRATCH|EXTERNAL/i.test(String(t.exit_reason || ''));
    const leftOnTable =
      t.mfe != null && t.mfe >= 4 && t.pnl_pts > 0 && t.pnl_pts < t.mfe * 0.4;

    if (soft && t.pnl_pts < 0) {
      soft_losses += 1;
      if (t.direction === 'SELL') {
        soft_sell_losses += 1;
        bump(
          acc,
          'soft_sell_spam',
          'Soft SELL loss chain',
          `${t.direction} ${t.pnl_pts.toFixed(2)} · ${reason}`
        );
      } else if (t.direction === 'BUY') {
        soft_buy_losses += 1;
        bump(
          acc,
          'soft_buy_spam',
          'Soft BUY loss chain',
          `${t.direction} ${t.pnl_pts.toFixed(2)} · ${reason}`
        );
      } else {
        bump(acc, 'soft_loss', 'Soft HardInv losses', `? ${t.pnl_pts.toFixed(2)} · ${reason}`);
      }
    }
    if (scratch && t.pnl_pts <= 0) {
      micro_scratches += 1;
      bump(
        acc,
        'micro_scratch',
        'Micro scratch closes (Limit/structure)',
        `${t.pnl_pts.toFixed(2)} · ${String(t.exit_reason || '').slice(0, 60)}`
      );
    }
    if (leftOnTable) {
      green_not_banked += 1;
      bump(
        acc,
        'green_not_banked',
        'Soft+ green not banked (plus → Soft minus risk)',
        `MFE ${t.mfe} → banked ${t.pnl_pts.toFixed(2)}`
      );
    }
  }

  if (soft_sell_losses >= 2) {
    bump(
      acc,
      'soft_sell_spam',
      'Repeated Soft SELL — bias spam',
      `${soft_sell_losses} Soft SELL in window · E=${session_e.toFixed(2)}`
    );
  }
  if (session_e < 0 && soft_losses >= 2 && green_not_banked >= 1) {
    bump(
      acc,
      'rr_inverted',
      'R:R inverted — Soft eats more than Peak banks',
      `E=${session_e.toFixed(2)} softL=${soft_losses} leftOnTable=${green_not_banked}`
    );
  }
  // Undirected Soft pile — still register soft_loss once from total, not per-cycle inflate
  if (soft_losses >= 2 && soft_sell_losses + soft_buy_losses === 0) {
    bump(acc, 'soft_loss', 'Soft HardInv losses', `softL=${soft_losses} · E=${session_e.toFixed(2)}`);
  }

  const patterns: BrainErrorPattern[] = [...acc.values()].map((a) => ({
    id: a.id,
    label: a.label,
    count: a.count,
    evidence: a.evidence,
    first_seen: now,
    last_seen: now,
  }));

  // Merge prior experience labels/first_seen without += inflating count
  try {
    const prior = loadExperience();
    for (const p of patterns) {
      const old = prior.patterns.find((x) => x.id === p.id);
      if (old) {
        p.first_seen = old.first_seen || p.first_seen;
        p.evidence = [...new Set([...(old.evidence || []).slice(-4), ...p.evidence])].slice(-10);
      }
    }
  } catch {
    /* fresh */
  }

  const top_pattern = pickTopPattern(patterns, soft_sell_losses, soft_buy_losses);
  const summary = top_pattern
    ? `E=${session_e.toFixed(2)} · top=${top_pattern.id}×${top_pattern.count} · softL=${soft_losses} · scratch=${micro_scratches} · leftTable=${green_not_banked}`
    : `E=${session_e.toFixed(2)} · no dominant pattern · softL=${soft_losses}`;

  return {
    trades: window,
    patterns,
    top_pattern,
    session_e,
    soft_losses,
    soft_sell_losses,
    soft_buy_losses,
    micro_scratches,
    green_not_banked,
    summary,
  };
}
