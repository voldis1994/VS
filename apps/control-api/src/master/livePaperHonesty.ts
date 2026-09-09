/**
 * Honesty gate for live-paper CLOSED proofs.
 * Kept separate from livePaperDemo.ts so tests/verify can import without running the demo.
 */

export type LivePaperDemoReport = {
  status: string;
  forced_live_paper_fill?: boolean;
  executed_cycles?: number;
  exit_phase?: boolean;
  exit_cycles?: number;
  exit_reason?: string | null;
  open_positions?: number;
  traded?: number;
  performance_trades?: number;
  /** Closed-book KPI from performance.total_pnl — required for honest CLOSED. */
  performance_total_pnl?: number | null;
  ticks?: Array<{ mid?: number; executed?: boolean; phase?: string }>;
  [k: string]: unknown;
};

/**
 * CLOSED must mean one clean fill→exit path, not manage-timer churn on a flat mid.
 */
export function isHonestLivePaperClosed(report: LivePaperDemoReport): boolean {
  if (report.status !== 'PASS_LIVE_DATA_CLOSED') return false;
  if (report.forced_live_paper_fill === true) return false;
  if ((report.performance_trades ?? 0) < 1) return false;
  // Closed book must expose finite total_pnl (0 is ok; missing is not)
  if (
    typeof report.performance_total_pnl !== 'number' ||
    !Number.isFinite(report.performance_total_pnl)
  ) {
    return false;
  }
  if ((report.open_positions ?? 0) !== 0) return false;
  if ((report.traded ?? 0) < 1) return false;
  // One (or at most two) natural fills — flood = churn, not a proof
  if ((report.executed_cycles ?? 0) < 1 || (report.executed_cycles ?? 0) > 2) {
    return false;
  }
  // Exit must be observed on tick / exit_drive — not only status.last_exit_reason
  const tickObservedExit =
    report.exit_phase === true || (report.exit_cycles ?? 0) >= 1;
  if (!tickObservedExit) return false;
  if (!report.exit_reason) return false;
  // Reject flat-mid churn floods (identical mid + many executes)
  const liveTicks = (report.ticks || []).filter((t) => t.phase !== 'exit_drive');
  const execMids = liveTicks
    .filter((t) => t.executed)
    .map((t) => t.mid)
    .filter((m): m is number => typeof m === 'number' && Number.isFinite(m));
  if (execMids.length >= 5) {
    const first = execMids[0];
    if (execMids.every((m) => Math.abs(m - first!) < 1e-9)) return false;
  }
  return true;
}

/**
 * Verify may retry when live quotes/filters miss a fill (DECIDED/TRADED),
 * but must not retry forever or after a hard feed FAIL.
 */
export function shouldRetryLivePaperDemo(status: string | null | undefined): boolean {
  return (
    status === 'PASS_LIVE_DATA_DECIDED' || status === 'PASS_LIVE_DATA_TRADED'
  );
}
