import { describe, expect, it, beforeEach } from 'vitest';
import {
  AUTO_CALIBRATE_EVERY_N,
  AUTO_CALIBRATE_COOLDOWN_MS,
  AUTO_CAL_MAX_SAFETY_TP_RR,
  AUTO_CAL_MAX_TARGET_ABS,
  CORE_ALWAYS_ON_REGIMES,
  MIN_ENABLED_REGIMES,
  _resetAutoCalibrateForTests,
  beginAutoCalibrateSession,
  getAutoCalibrateStatus,
  isAutoCalibrateCooldownActive,
  ensureAutoCalibrateSession,
  noteClosedTradeForAutoCalibrate,
  proposeAutoCalibration,
  resetClientToOpenTradeAll,
  softPctFromAbs,
} from './autoCalibrate.js';
import {
  defaultDeskCalibration,
  getDeskCalibration,
  setDeskCalibration,
  _resetDeskCalibrationCacheForTests,
} from './deskCalibration.js';
import {
  getBrainGenome,
  _resetBrainGenomeForTests,
} from '../brainSelfImprove/brainGenome.js';

function trade(partial: {
  pnl_pts: number;
  regime?: string;
  exit_reason?: string;
  mfe?: number;
  mae?: number;
  entry_ctx?: { chapter?: string | null } | null;
}) {
  return {
    pnl_pts: partial.pnl_pts,
    regime: partial.regime ?? 'TREND_UP',
    setup_type: 'PULLBACK',
    exit_reason: partial.exit_reason ?? 'PeakProtection',
    mfe: partial.mfe ?? Math.max(partial.pnl_pts, 0),
    mae: partial.mae ?? Math.min(partial.pnl_pts, 0),
    at: new Date().toISOString(),
    entry_ctx: partial.entry_ctx ?? null,
  };
}

describe('autoCalibrate', () => {
  beforeEach(() => {
    _resetAutoCalibrateForTests();
    _resetDeskCalibrationCacheForTests();
    setDeskCalibration(defaultDeskCalibration());
  });

  it('resets watch on robot START and counts until next cycle', () => {
    const st = beginAutoCalibrateSession('test');
    expect(st.closes_in_session).toBe(0);
    expect(st.closes_until_next).toBe(AUTO_CALIBRATE_EVERY_N);
    expect(st.session_started_at).toBeTruthy();
  });

  it('calibrates every 5 closes — raises Peak/Target when micro-wins vs Soft losses', () => {
    beginAutoCalibrateSession('test');
    const before = defaultDeskCalibration();
    // 4 closes — no cycle yet
    for (let i = 0; i < 4; i++) {
      const r = noteClosedTradeForAutoCalibrate(
        trade({ pnl_pts: 0.4, exit_reason: 'PeakProtection' })
      );
      expect(r).toBeNull();
    }
    expect(getAutoCalibrateStatus().closes_in_session).toBe(4);

    // 5th — Soft losses + micro wins → let winners run
    const cycle = noteClosedTradeForAutoCalibrate(
      trade({ pnl_pts: -2.2, exit_reason: 'HardInvalidation · Soft', regime: 'RANGE' })
    );
    expect(cycle).toBeTruthy();
    expect(cycle!.changes.length).toBeGreaterThan(0);
    expect(cycle!.next.peak_mfe_abs).toBeGreaterThan(before.peak_mfe_abs);
    expect(cycle!.next.target_abs).toBeGreaterThanOrEqual(before.target_abs);
    expect(getAutoCalibrateStatus().cycles_run).toBe(1);
  });

  it('soft-demotes satellite regime; prefers satellites before cores', () => {
    const current = defaultDeskCalibration();
    const window = [
      trade({ pnl_pts: -1.5, regime: 'BREAKOUT_UP', exit_reason: 'HardInvalidation' }),
      trade({ pnl_pts: -1.2, regime: 'BREAKOUT_UP', exit_reason: 'HardInvalidation' }),
      trade({ pnl_pts: 2.0, regime: 'TREND_UP', exit_reason: 'PeakProtection' }),
      trade({ pnl_pts: 2.5, regime: 'TREND_UP', exit_reason: 'Target' }),
      trade({ pnl_pts: 1.0, regime: 'PULLBACK_UPTREND', exit_reason: 'PeakProtection' }),
    ];
    const demoted = new Set<string>();
    const result = proposeAutoCalibration(current, window, demoted);
    expect(result.next.enabled_regimes.length).toBeGreaterThanOrEqual(MIN_ENABLED_REGIMES);
    expect(result.next.enabled_regimes.includes('BREAKOUT_UP' as never)).toBe(false);
    expect(result.next.enabled_regimes.includes('TREND_UP' as never)).toBe(true);
    expect(result.next.soft_off_regimes.includes('BREAKOUT_UP' as never)).toBe(true);
    expect(result.changes.some((c) => c.includes('regime Soft OFF BREAKOUT_UP'))).toBe(true);
  });

  it('may Soft OFF preferred RANGE when it is a clear loser (freedom · no core ban)', () => {
    const current = defaultDeskCalibration();
    const window = [
      trade({ pnl_pts: -2, regime: 'RANGE' }),
      trade({ pnl_pts: -2, regime: 'RANGE' }),
      trade({ pnl_pts: 1, regime: 'TREND_UP' }),
      trade({ pnl_pts: 1, regime: 'TREND_UP' }),
      trade({ pnl_pts: 0.5, regime: 'TREND_DOWN' }),
    ];
    const result = proposeAutoCalibration(current, window, new Set());
    expect(result.next.enabled_regimes.length).toBeGreaterThanOrEqual(MIN_ENABLED_REGIMES);
    expect(result.next.enabled_regimes.includes('RANGE' as never)).toBe(false);
    expect(result.next.soft_off_regimes.includes('RANGE' as never)).toBe(true);
    expect(result.changes.some((c) => c.includes('regime Soft OFF RANGE'))).toBe(true);
    // Floor still keeps preferred liquid regimes present overall
    expect(CORE_ALWAYS_ON_REGIMES.some((r) => result.next.enabled_regimes.includes(r as never))).toBe(
      true
    );
  });

  it('never empties allowlist even if all window regimes lose', () => {
    const current = {
      ...defaultDeskCalibration(),
      enabled_regimes: ['RANGE', 'TREND_UP', 'TREND_DOWN', 'BREAKOUT_UP', 'EXPANSION'] as never,
    };
    const window = [
      trade({ pnl_pts: -2, regime: 'RANGE' }),
      trade({ pnl_pts: -2, regime: 'RANGE' }),
      trade({ pnl_pts: -1, regime: 'TREND_UP' }),
      trade({ pnl_pts: -1, regime: 'TREND_UP' }),
      trade({ pnl_pts: -0.5, regime: 'BREAKOUT_UP' }),
    ];
    const result = proposeAutoCalibration(current, window, new Set());
    expect(result.next.enabled_regimes.length).toBeGreaterThanOrEqual(MIN_ENABLED_REGIMES);
  });

  it('does not block — lot/knobs only; propose leaves trading possible', () => {
    const r = proposeAutoCalibration(defaultDeskCalibration(), [
      trade({ pnl_pts: 3 }),
      trade({ pnl_pts: 3 }),
      trade({ pnl_pts: 2 }),
      trade({ pnl_pts: -1 }),
      trade({ pnl_pts: 2 }),
    ]);
    expect(r.next.enabled_regimes.length).toBeGreaterThanOrEqual(MIN_ENABLED_REGIMES);
  });

  it('applied cycle starts 3m entry cooldown and records history', () => {
    beginAutoCalibrateSession('test');
    expect(isAutoCalibrateCooldownActive()).toBe(false);
    for (let i = 0; i < 4; i++) {
      noteClosedTradeForAutoCalibrate(trade({ pnl_pts: 0.3, exit_reason: 'PeakProtection' }));
    }
    const cycle = noteClosedTradeForAutoCalibrate(
      trade({ pnl_pts: -2.2, exit_reason: 'HardInvalidation', regime: 'RANGE' })
    );
    expect(cycle?.applied).toBe(true);
    expect(isAutoCalibrateCooldownActive()).toBe(true);
    const st = getAutoCalibrateStatus();
    expect(st.cooling_down).toBe(true);
    expect(st.cooldown_left_s).toBeGreaterThan(160);
    expect(st.cooldown_left_s).toBeLessThanOrEqual(AUTO_CALIBRATE_COOLDOWN_MS / 1000);
    expect(st.history.length).toBeGreaterThanOrEqual(1);
    expect(st.history[0]?.applied).toBe(true);
    expect(st.knobs_now.peak_mfe_abs).toBeGreaterThan(3);
  });

  it('raises broker SAFETY TP R:R when micro-wins vs modest Soft (not Soft-heavy dominate)', () => {
    const base = defaultDeskCalibration();
    const r = proposeAutoCalibration(base, [
      trade({ pnl_pts: 0.8, exit_reason: 'Target', mfe: 0.9 }),
      trade({ pnl_pts: 0.7, exit_reason: 'Target', mfe: 0.8 }),
      trade({ pnl_pts: -1.0, exit_reason: 'HardInvalidation' }),
      trade({ pnl_pts: 0.6, exit_reason: 'PeakProtection', mfe: 0.7 }),
      trade({ pnl_pts: -0.9, exit_reason: 'HardInvalidation' }),
    ]);
    expect(r.applied).toBe(true);
    // Soft-sized bar is Soft*0.65≈1.43 — these losses stay under Soft-heavy
    expect(r.next.hardinv_abs).toBe(base.hardinv_abs);
    expect(r.next.safety_tp_rr).toBeGreaterThan(base.safety_tp_rr);
    expect(r.next.safety_tp_rr).toBeLessThanOrEqual(AUTO_CAL_MAX_SAFETY_TP_RR);
    expect(r.changes.some((c) => c.includes('safety_tp_rr'))).toBe(true);
    expect(r.changes.some((c) => c.includes('WHAT ·') && c.includes('WHY ·'))).toBe(true);
  });

  it('Soft-heavy pullback tightens hardinv_abs and syncs hardinv_pct from abs', () => {
    const base = defaultDeskCalibration();
    const r = proposeAutoCalibration(
      base,
      [
        trade({ pnl_pts: -2.2, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: -2.0, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: 0.3, exit_reason: 'PeakProtection', mfe: 2.5 }),
        trade({ pnl_pts: -1.8, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: 0.2, exit_reason: 'PeakProtection', mfe: 2.0 }),
      ],
      new Set(),
      { raise_streak: 3 }
    );
    expect(r.applied).toBe(true);
    expect(r.next.hardinv_abs).toBeLessThan(base.hardinv_abs);
    expect(r.next.hardinv_pct).toBe(softPctFromAbs(r.next.hardinv_abs));
    expect(r.changes.some((c) => c.includes('hardinv_abs') && c.includes('Soft tighten'))).toBe(
      true
    );
    // No microscopic hardinv_pct WHAT spam (0.00080→0.00084)
    expect(r.changes.some((c) => /WHAT · hardinv_pct /.test(c))).toBe(false);
  });

  it('softPctFromAbs uses clean 0.0001 steps — factory Soft 2.2 → 0.0008', () => {
    expect(softPctFromAbs(2.2)).toBe(0.0008);
    expect(softPctFromAbs(2.4)).toBe(0.0009);
    expect(softPctFromAbs(2.0)).toBe(0.0007);
    expect(softPctFromAbs(2.4)).not.toBe(0.00084);
  });

  it('Soft ease never logs hardinv_pct 5-decimal junk', () => {
    const base = {
      ...defaultDeskCalibration(),
      hardinv_abs: 1.4,
      hardinv_pct: 0.0005,
      peak_mfe_abs: 4.0,
      target_abs: 7.0,
    };
    const r = proposeAutoCalibration(base, [
      trade({ pnl_pts: -1.0, exit_reason: 'HardInvalidation', mfe: 3.5 }),
      trade({ pnl_pts: -1.1, exit_reason: 'HardInvalidation', mfe: 3.2 }),
      trade({ pnl_pts: 0.4, exit_reason: 'PeakProtection', mfe: 3.0 }),
      trade({ pnl_pts: 0.5, exit_reason: 'PeakProtection', mfe: 2.8 }),
      trade({ pnl_pts: 0.3, exit_reason: 'PeakProtection', mfe: 2.5 }),
    ]);
    expect(r.changes.some((c) => /WHAT · hardinv_pct /.test(c))).toBe(false);
    expect(r.changes.some((c) => /0\.000\d{2,}→0\.000\d{2,}/.test(c))).toBe(false);
    expect(r.next.hardinv_pct).toBe(softPctFromAbs(r.next.hardinv_abs));
    expect(String(r.next.hardinv_pct)).toMatch(/^0\.000\d$/);
  });

  it('Soft-heavy without HardInv tag still tightens Soft (MindCut/Structure sized losses)', () => {
    const base = {
      ...defaultDeskCalibration(),
      hardinv_abs: 2.2,
      peak_mfe_abs: 3.7,
      peak_retention: 0.72,
      target_abs: 6.3,
    };
    const r = proposeAutoCalibration(base, [
      trade({ pnl_pts: -3.85, exit_reason: 'MindCut' }),
      trade({ pnl_pts: -3.85, exit_reason: 'StructureInvalidation' }),
      trade({ pnl_pts: -3.9, exit_reason: 'EXTERNAL · Capital' }),
      trade({ pnl_pts: -3.8, exit_reason: 'TimeDecay' }),
      trade({ pnl_pts: 0, exit_reason: 'Scratch' }),
    ]);
    expect(r.applied).toBe(true);
    expect(r.next.hardinv_abs).toBe(1.9);
    expect(r.next.hardinv_pct).toBe(softPctFromAbs(1.9));
    expect(r.next.peak_mfe_abs).toBeLessThan(base.peak_mfe_abs);
    expect(r.next.target_abs).toBeLessThan(base.target_abs);
    expect(r.changes.some((c) => c.includes('hardinv_abs') && c.includes('Soft tighten'))).toBe(
      true
    );
    expect(r.changes.some((c) => /WHAT · hardinv_pct /.test(c))).toBe(false);
    expect(r.changes.some((c) => c.includes('WHAT ·') && c.includes('WHY ·'))).toBe(true);
  });

  it('Soft steps are clean decimals (2.2→2.0 not 1.9998)', () => {
    const base = { ...defaultDeskCalibration(), hardinv_abs: 1.4 };
    const r = proposeAutoCalibration(
      base,
      [
        trade({ pnl_pts: -2.2, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: -2.0, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: 0.2, exit_reason: 'PeakProtection', mfe: 1.5 }),
        trade({ pnl_pts: -1.8, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: 0.1, exit_reason: 'PeakProtection', mfe: 1.2 }),
      ],
      new Set(),
      { raise_streak: 3 }
    );
    expect(r.next.hardinv_abs).toBe(1.1);
    expect(Number.isInteger(r.next.hardinv_abs * 10)).toBe(true);
    expect(String(r.next.hardinv_abs)).not.toMatch(/\.\d{3,}/);
    // Peak/Target/retention also clean — no float dust
    expect(Number.isInteger(r.next.peak_mfe_abs * 10)).toBe(true);
    expect(Number.isInteger(r.next.target_abs * 10)).toBe(true);
    expect(Number.isInteger(r.next.peak_retention * 100)).toBe(true);
    // Abs logs: 1 decimal only (pct knobs use 5 by design)
    for (const c of r.changes.filter((x) => /hardinv_abs|peak_mfe_abs|target_abs|peak_retention|safety_tp_rr/.test(x))) {
      expect(c).not.toMatch(/(?:hardinv_abs|peak_mfe_abs|target_abs) \d+\.\d{2,}/);
    }
  });

  it('pulls back when targets overreached and expectancy still negative', () => {
    const tall = {
      ...defaultDeskCalibration(),
      safety_tp_rr: 2.0,
      peak_mfe_abs: 4.5,
      peak_retention: 0.75,
      target_abs: 7.0,
      entry_filter_level: 3,
    };
    const r = proposeAutoCalibration(
      tall,
      [
        trade({ pnl_pts: 0.3, exit_reason: 'PeakProtection' }),
        trade({ pnl_pts: -2.2, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: 0.2, exit_reason: 'PeakProtection' }),
        trade({ pnl_pts: -1.8, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: -0.9 }),
      ],
      new Set(),
      { raise_streak: 3 }
    );
    expect(r.applied).toBe(true);
    expect(r.next.safety_tp_rr).toBeLessThan(tall.safety_tp_rr);
    expect(r.next.target_abs).toBeLessThan(tall.target_abs);
    // Filters free — no longer forced to OPEN on pullback
    expect(r.next.entry_filter_level).toBeGreaterThanOrEqual(0);
    expect(r.next.entry_filter_level).toBeLessThanOrEqual(3);
    expect(r.changes.some((c) => /pullback|ease|PRĀTS|MĀCĪBA|filtr/i.test(c))).toBe(true);
  });

  it('never raises Target / TP RR past hard caps', () => {
    const nearCap = {
      ...defaultDeskCalibration(),
      safety_tp_rr: AUTO_CAL_MAX_SAFETY_TP_RR,
      target_abs: AUTO_CAL_MAX_TARGET_ABS,
      peak_mfe_abs: 4.5,
    };
    const r = proposeAutoCalibration(nearCap, [
      trade({ pnl_pts: 0.2 }),
      trade({ pnl_pts: -2 }),
      trade({ pnl_pts: 0.3 }),
      trade({ pnl_pts: -1.5 }),
      trade({ pnl_pts: 0.1 }),
    ]);
    expect(r.next.safety_tp_rr).toBeLessThanOrEqual(AUTO_CAL_MAX_SAFETY_TP_RR);
    expect(r.next.target_abs).toBeLessThanOrEqual(AUTO_CAL_MAX_TARGET_ABS);
  });

  it('may raise entry_filter_level on knife Soft window (filters free)', () => {
    const base = defaultDeskCalibration();
    expect(base.entry_filter_level).toBe(0);
    const r = proposeAutoCalibration(base, [
      trade({
        pnl_pts: -2,
        exit_reason: 'HardInvalidation',
        entry_ctx: { chapter: 'BOUNCE_IN_SELL' },
      }),
      trade({
        pnl_pts: -1.5,
        exit_reason: 'HardInvalidation',
        entry_ctx: { chapter: 'RANGE_CHOP' },
      }),
      trade({ pnl_pts: -0.8, entry_ctx: { chapter: 'BOUNCE_IN_SELL' } }),
      trade({ pnl_pts: 0.2 }),
      trade({
        pnl_pts: -1.2,
        exit_reason: 'HardInvalidation',
        entry_ctx: { chapter: 'DIP_IN_RALLY' },
      }),
    ]);
    expect(r.next.entry_filter_level).toBeGreaterThanOrEqual(1);
    expect(r.changes.some((c) => c.includes('entry_filter_level'))).toBe(true);
  });

  it('eases entry_filter_level toward OPEN after clearly positive window', () => {
    const base = { ...defaultDeskCalibration(), entry_filter_level: 2 };
    const r = proposeAutoCalibration(base, [
      trade({ pnl_pts: 4, exit_reason: 'PeakProtection', mfe: 5 }),
      trade({ pnl_pts: 3.5, exit_reason: 'Target', mfe: 4 }),
      trade({ pnl_pts: 2, exit_reason: 'PeakProtection', mfe: 3 }),
      trade({ pnl_pts: 5, exit_reason: 'PeakProtection', mfe: 6 }),
      trade({ pnl_pts: 1.5, exit_reason: 'TimeDecay', mfe: 2 }),
    ]);
    expect(r.next.entry_filter_level).toBeLessThan(2);
  });

  it('Soft-heavy window applies Soft tighten (no longer silent hold)', () => {
    const base = defaultDeskCalibration();
    const r = proposeAutoCalibration(base, [
      trade({ pnl_pts: -2.0, exit_reason: 'HardInvalidation' }),
      trade({ pnl_pts: -1.8, exit_reason: 'HardInvalidation' }),
      trade({ pnl_pts: -0.5 }),
      trade({ pnl_pts: 0.3, exit_reason: 'PeakProtection', mfe: 0.4 }),
      trade({ pnl_pts: -1.5, exit_reason: 'HardInvalidation' }),
    ]);
    expect(r.changes.some((c) => c.startsWith('PRĀTS'))).toBe(true);
    expect(r.changes.some((c) => c.startsWith('MĀCĪBA'))).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.next.hardinv_abs).toBeLessThan(base.hardinv_abs);
    expect(r.changes.some((c) => c.includes('WHAT ·') && c.includes('WHY ·'))).toBe(true);
  });

  it('pullback/ease never raises Peak/Target/TP on factory Soft floor', () => {
    const base = defaultDeskCalibration();
    expect(base.hardinv_abs).toBe(2.2);
    expect(base.peak_mfe_abs).toBe(3.0);
    expect(base.target_abs).toBe(5.0);
    const r = proposeAutoCalibration(
      base,
      [
        trade({ pnl_pts: 0.3, exit_reason: 'PeakProtection', mfe: 2.5 }),
        trade({ pnl_pts: -2.2, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: 0.2, exit_reason: 'PeakProtection', mfe: 2.0 }),
        trade({ pnl_pts: -1.8, exit_reason: 'HardInvalidation' }),
        trade({ pnl_pts: -0.9 }),
      ],
      new Set(),
      { raise_streak: 3 }
    );
    // Old bug: Math.max(hardinv+1.5, peak-0.5) raised Peak 3.0→3.7 and Target 5.0→5.2
    expect(r.next.peak_mfe_abs).toBeLessThanOrEqual(base.peak_mfe_abs);
    expect(r.next.target_abs).toBeLessThanOrEqual(base.target_abs);
    expect(r.next.safety_tp_rr).toBeLessThanOrEqual(base.safety_tp_rr);
    expect(r.changes.some((c) => c.includes('PRĀTS') || c.includes('ease') || c.includes('pullback'))).toBe(
      true
    );
  });

  it('isolates auto-cal per client — A closes do not count for B', () => {
    beginAutoCalibrateSession('A', 1);
    beginAutoCalibrateSession('B', 2);
    noteClosedTradeForAutoCalibrate(trade({ pnl_pts: -1 }), 1);
    noteClosedTradeForAutoCalibrate(trade({ pnl_pts: -1 }), 1);
    expect(getAutoCalibrateStatus(undefined, 1).closes_in_session).toBe(2);
    expect(getAutoCalibrateStatus(undefined, 2).closes_in_session).toBe(0);
    noteClosedTradeForAutoCalibrate(trade({ pnl_pts: 1 }), 2);
    expect(getAutoCalibrateStatus(undefined, 1).closes_in_session).toBe(2);
    expect(getAutoCalibrateStatus(undefined, 2).closes_in_session).toBe(1);
  });

  it('ensureAutoCalibrateSession on robot START keeps counted closes (no wipe)', () => {
    beginAutoCalibrateSession('first');
    setDeskCalibration({
      ...defaultDeskCalibration(),
      hardinv_abs: 4.5,
      peak_mfe_abs: 5,
      target_abs: 8,
      safety_tp_rr: 2.5,
      entry_filter_level: 3,
    });
    noteClosedTradeForAutoCalibrate(trade({ pnl_pts: -1 }));
    noteClosedTradeForAutoCalibrate(trade({ pnl_pts: -0.5 }));
    const st = ensureAutoCalibrateSession('robot restart');
    expect(st.closes_in_session).toBe(2);
    expect(st.session_started_at).toBeTruthy();
    // Knobs NOT factory-reset on ordinary START — only SĀKT NO JAUNA wipes
    const cal = getDeskCalibration();
    expect(cal.hardinv_abs).toBe(4.5);
    expect(cal.entry_filter_level).toBe(3);
  });

  it('ensureAutoCalibrateSession starts watch once when empty', () => {
    _resetAutoCalibrateForTests(0);
    const st = ensureAutoCalibrateSession('cold start');
    expect(st.closes_in_session).toBe(0);
    expect(st.session_started_at).toBeTruthy();
  });

  it('resetClientToOpenTradeAll restores defaults and clears watch', () => {
    beginAutoCalibrateSession('dirty');
    setDeskCalibration({
      ...defaultDeskCalibration(),
      entry_filter_level: 2,
      hardinv_abs: 3.5,
    });
    noteClosedTradeForAutoCalibrate(trade({ pnl_pts: 1 }));
    const st = resetClientToOpenTradeAll(undefined, 'factory_open');
    expect(st.closes_in_session).toBe(0);
    expect(getDeskCalibration().entry_filter_level).toBe(0);
    expect(getDeskCalibration().hardinv_abs).toBe(2.2);
    expect(st.last_changes.some((c) => c.includes('factory open'))).toBe(true);
  });

  it('counts close even when pnl is 0 / scratch', () => {
    beginAutoCalibrateSession('test');
    for (let i = 0; i < 4; i++) {
      expect(noteClosedTradeForAutoCalibrate(trade({ pnl_pts: 0 }))).toBeNull();
    }
    expect(getAutoCalibrateStatus().closes_in_session).toBe(4);
    const cycle = noteClosedTradeForAutoCalibrate(trade({ pnl_pts: 0 }));
    expect(cycle).toBeTruthy();
    expect(getAutoCalibrateStatus().cycles_run).toBe(1);
  });

  it('softens entry_filter_level after clearly positive window', () => {
    const base = { ...defaultDeskCalibration(), entry_filter_level: 2 };
    const r = proposeAutoCalibration(base, [
      trade({ pnl_pts: 2.5 }),
      trade({ pnl_pts: 1.8 }),
      trade({ pnl_pts: 3.0 }),
      trade({ pnl_pts: 1.2 }),
      trade({ pnl_pts: -0.4 }),
    ]);
    // One step toward OPEN per cycle (not hard-reset to 0)
    expect(r.next.entry_filter_level).toBe(1);
  });

  it('Soft TREND bounce window tightens pullback_episode Soft× knobs', () => {
    _resetBrainGenomeForTests({
      pullback_episode_enabled: true,
      pullback_episode_peak_arm_soft_mult: 1.0,
      pullback_episode_min_mfe_soft_mult: 0.5,
    });
    const base = defaultDeskCalibration();
    const r = proposeAutoCalibration(
      base,
      [
        trade({
          pnl_pts: -2.2,
          regime: 'TREND_DOWN',
          exit_reason: 'HardInvalidation',
          entry_ctx: { chapter: 'BOUNCE_IN_SELL' },
          mfe: 1.2,
        }),
        trade({
          pnl_pts: -2.0,
          regime: 'TREND_DOWN',
          exit_reason: 'HardInvalidation',
          entry_ctx: { chapter: 'BOUNCE_IN_SELL' },
          mfe: 0.9,
        }),
        trade({ pnl_pts: 0.3, regime: 'TREND_UP', exit_reason: 'PeakProtection', mfe: 2.5 }),
        trade({
          pnl_pts: -1.8,
          regime: 'TREND_DOWN',
          exit_reason: 'HardInvalidation',
          entry_ctx: { chapter: 'EXHAUST_LO' },
          mfe: 1.0,
        }),
        trade({ pnl_pts: 0.2, regime: 'RANGE', exit_reason: 'PeakProtection', mfe: 2.0 }),
      ],
      new Set(),
      { genome: getBrainGenome() }
    );
    expect(r.genome_patch?.pullback_episode_peak_arm_soft_mult).toBe(0.95);
    expect(r.genome_patch?.pullback_episode_min_mfe_soft_mult).toBe(0.45);
    expect(
      (r.genome_changes || []).some((c) => c.includes('pullback_episode_peak_arm_soft_mult'))
    ).toBe(true);
  });
});
