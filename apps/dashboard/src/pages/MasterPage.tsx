import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../hooks/useApi';

type MasterStatus = {
  mode: string;
  running: boolean;
  kill_switch: boolean;
  epic: string;
  ai_mode: string;
  owns_pipeline: boolean;
  broker: string | null;
  broker_detail: string | null;
  primary_live_venue?: string;
  capital_env_present?: boolean;
  capital_desk_creds_seen?: boolean;
  capital_credential_source?: 'env' | 'desk' | null;
  capital_creds_available?: boolean;
  capital_live_attached?: boolean;
  capital_account_proven?: boolean | null;
  capital_venue_opens?: number;
  capital_venue_opens_proven?: boolean;
  last_decision: { kind?: string } | null;
  last_block_reason: string | null;
  last_execution_detail: string | null;
  last_exit_reason: string | null;
  last_close_failed?: {
    position_id: string;
    exit_reason: string;
    detail: string;
    ts: string;
  } | null;
  buy_score: number;
  sell_score: number;
  regime: string;
  market_state: string;
  last_market?: {
    ok: boolean;
    quality: number;
    reasons: string[];
    bars_in: number;
    bars_out: number;
  } | null;
  account: {
    equity: number | null;
    balance: number | null;
    daily_pnl: number | null;
    day_start_equity?: number | null;
    peak_equity?: number | null;
    available_to_deal?: number | null;
    trade_allowed?: boolean | null;
    consecutive_losses?: number | null;
  } | null;
  open_positions: number;
  performance: {
    expectancy?: number;
    max_drawdown?: number;
    trades?: number;
    win_rate?: number;
    profit_factor?: number;
    total_fees?: number;
    total_pnl?: number;
  } | null;
  monte_carlo?: {
    p05?: number;
    p50?: number;
    p95?: number;
    equity_p05?: number;
    equity_p50?: number;
    equity_p95?: number;
    drawdown_p50?: number;
    drawdown_p95?: number;
  } | null;
  expectancy_would_block?: Array<{
    setup_key: string;
    ev: number;
    samples: number;
  }>;
  expectancy_gate_armed?: boolean;
  entry_gates?: {
    news_cfg_on: boolean;
    news_blocks: boolean;
    news_detail: string | null;
    block_off_hours: boolean;
    weekend: boolean;
    session: string;
    session_blocks: boolean;
    hours_ok: boolean;
  };
  monitoring?: {
    last_cycle_ms?: number;
    relative_spread?: number | null;
    ack_latency_ms?: number | null;
    error_count?: number;
    error_rate_per_min?: number;
    data_freshness_ms?: number | null;
    instance_health?: string;
    entry_block_reason?: string | null;
    active_alerts?: Array<{ code: string; level: string; message: string }>;
  };
  opportunities: number;
  traded: number;
  blocked: number;
  health: string;
  recovered: boolean;
  persist_ok: boolean;
  last_persist_error: string | null;
  entries_armed: boolean;
  entries_pause_reason: string | null;
  structure_seed_source?: string;
  bars_available?: number;
  news_window?: {
    impact: string;
    window_active: boolean;
    source: string;
    detail: string;
  };
  quote?: {
    mid: number;
    bid: number;
    ask: number;
    spread: number;
    age_ms: number;
    stale_quote_ms?: number;
    stale?: boolean;
    stream_healthy: boolean | null;
  } | null;
  floating_pnl?: number | null;
  reject_cooldown_ms?: number;
  recent_errors?: Array<{
    ts: string;
    module: string;
    error_type: string;
    message: string;
  }>;
  recent_decisions?: Array<{
    ts: string;
    kind: string;
    executed: boolean;
    block_reason: string | null;
    execution_detail: string | null;
    opportunity_id?: string | null;
    buy_score?: number;
    sell_score?: number;
  }>;
  recent_trades?: Array<{
    ts: string;
    event: string;
    broker: string;
    ok: boolean;
    detail: string | null;
    pnl: number | null;
    fees?: number | null;
    opportunity_id?: string | null;
  }>;
  manage?: {
    scalp_pct_chase?: boolean;
    soft_trail_money_arm?: number;
    soft_trail_pips?: number;
    multi_tp_count?: number;
    breakeven_activation_money?: number;
    require_positive_expectancy?: boolean;
    min_expectancy_samples?: number;
    be_start?: number;
    trail_start?: number;
    trail_lock?: number;
    partial_close_progress?: number;
    partial_close_volume?: number;
    close_all_profit?: number;
    close_all_loss?: number;
    max_hold_ms?: number;
    min_score?: number;
    daily_loss_limit?: number;
    block_high_impact_news?: boolean;
    block_off_hours?: boolean;
  };
};

type ManagedPos = {
  position_id: string;
  epic: string;
  side: string;
  size: number;
  entry: number;
  mfe: number;
  mae: number;
  stop_loss: number | null;
  take_profit?: number | null;
  upl?: number | null;
  broker_upl?: number | null;
  mark?: number | null;
  soft_trail_armed_at?: string | null;
  native_trail_armed?: boolean;
  partial_close_applied?: boolean;
  multi_tp_levels?: unknown[];
};

type JournalOpp = {
  id: string;
  epic: string;
  executed: boolean;
  block_reason?: string | null;
  decision?: { kind?: string; side?: string; block_reason?: string | null };
  outcome?: {
    pnl: number;
    exit_reason: string;
    position_id?: string;
    pnl_proven?: boolean;
    r_multiple?: number;
  };
};

type SetupEv = {
  setup_key: string;
  samples: number;
  ev: number;
  positive: boolean;
  p_win?: number;
};

export function MasterPage() {
  const [status, setStatus] = useState<MasterStatus | null>(null);
  const [positions, setPositions] = useState<ManagedPos[]>([]);
  const [journal, setJournal] = useState<JournalOpp[]>([]);
  const [blockedJournal, setBlockedJournal] = useState<JournalOpp[]>([]);
  const [setupEv, setSetupEv] = useState<SetupEv[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [epicInput, setEpicInput] = useState('GOLD');
  const [replayNote, setReplayNote] = useState<string | null>(null);

  const pushLog = useCallback((msg: string) => {
    const t = new Date().toISOString().slice(11, 19);
    setLog((prev) => [`[${t}] ${msg}`, ...prev].slice(0, 40));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, p, j] = await Promise.all([
        apiFetch<MasterStatus>('/api/master/status'),
        apiFetch<{ positions: ManagedPos[] }>('/api/master/positions'),
        apiFetch<{
          opportunities: JournalOpp[];
          expectancy?: SetupEv[];
        }>('/api/master/journal'),
      ]);
      setStatus(s);
      if (s.epic) setEpicInput(s.epic);
      setPositions(p.positions || []);
      const opps = j.opportunities || [];
      setJournal(
        opps
          .filter((o) => o.executed && o.outcome)
          .slice(-30)
          .reverse()
      );
      setBlockedJournal(
        opps
          .filter((o) => !o.executed)
          .slice(-20)
          .reverse()
      );
      setSetupEv(j.expectancy || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const r = await fn();
      const detail =
        r && typeof r === 'object' && 'detail' in r
          ? String((r as { detail?: unknown }).detail || '')
          : '';
      const ok =
        r && typeof r === 'object' && 'ok' in r
          ? Boolean((r as { ok?: unknown }).ok)
          : true;
      pushLog(`${label} ${JSON.stringify(r)}`);
      if (!ok && detail) setError(detail);
      await refresh();
    } catch (e) {
      pushLog(`${label} error ${e instanceof Error ? e.message : String(e)}`);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const expWould =
    status?.expectancy_would_block?.length
      ? `WOULD_GATE · ${status.expectancy_would_block
          .slice(0, 2)
          .map((e) => `${e.setup_key} EV=${e.ev.toFixed(2)} n=${e.samples}`)
          .join(' · ')}`
      : null;
  const why =
    status?.last_block_reason ||
    status?.monitoring?.entry_block_reason ||
    (status?.expectancy_gate_armed ? expWould : null) ||
    status?.last_execution_detail ||
    status?.last_decision?.kind ||
    '—';
  const wouldGateNote =
    !status?.expectancy_gate_armed && expWould ? expWould : null;
  const healthBad =
    !!status?.health?.includes('KILL') ||
    status?.health === 'PERSIST_DEGRADED' ||
    status?.health === 'LIVE_NO_CAPITAL' ||
    status?.health === 'LIVE_UNATTACHED' ||
    status?.health === 'LIVE_ACCOUNT_UNPROVEN' ||
    status?.health === 'LIVE_QUOTE_STALE' ||
    status?.health === 'LIVE_VENUE_UNPROVEN' ||
    status?.persist_ok === false;
  const quoteStale =
    status?.quote?.stale === true ||
    (status?.quote?.stale == null &&
      (status?.quote?.age_ms ?? 0) >
        (status?.quote?.stale_quote_ms ?? 15_000));

  const cards: Array<{ k: string; v: string; bad?: boolean; ok?: boolean }> = status
    ? [
        { k: 'Mode', v: status.mode },
        { k: 'Epic', v: status.epic || '—' },
        { k: 'Health', v: status.health, bad: healthBad, ok: !healthBad },
        { k: 'Broker', v: status.broker || '—' },
        { k: 'Broker detail', v: status.broker_detail || '—' },
        {
          k: 'Capital LIVE',
          v: status.capital_live_attached
            ? 'ATTACHED'
            : status.capital_creds_available
              ? status.capital_credential_source === 'desk'
                ? 'creds Brokers · not attached'
                : 'creds env · not attached'
              : 'need CAPITAL_* or Brokers keys',
          ok: !!status.capital_live_attached,
          bad: !status.capital_live_attached && status.mode === 'LIVE',
        },
        {
          k: 'Quote',
          v: status.quote
            ? `${Number(status.quote.mid).toFixed(2)} · spr ${Number(status.quote.spread).toFixed(2)} · ${Math.round(status.quote.age_ms / 1000)}s${
                status.quote.stream_healthy === true
                  ? ' · WS'
                  : status.quote.stream_healthy === false
                    ? ' · REST'
                    : ''
              }`
            : '—',
          bad: quoteStale,
          ok: !!status.quote && !quoteStale,
        },
        {
          k: 'Float UPL',
          v:
            status.floating_pnl != null
              ? Number(status.floating_pnl).toFixed(2)
              : '—',
          bad: status.floating_pnl != null && status.floating_pnl < 0,
          ok: status.floating_pnl != null && status.floating_pnl > 0,
        },
        {
          k: 'Manage',
          v: status.manage?.scalp_pct_chase
            ? `SCALP chase · soft£${status.manage.soft_trail_money_arm ?? 0} · TP×${status.manage.multi_tp_count ?? 0}`
            : 'structure/MFE (preset off)',
        },
        { k: 'Owns pipeline', v: status.owns_pipeline ? 'YES' : 'no', ok: !!status.owns_pipeline, bad: status.mode === 'LIVE' && !status.owns_pipeline },
        {
          k: 'Entries',
          v: status.entries_armed === false
            ? `PAUSED${status.entries_pause_reason ? ` · ${status.entries_pause_reason}` : ''}`
            : 'armed',
          bad: status.entries_armed === false,
          ok: status.entries_armed !== false,
        },
        {
          k: 'Structure seed',
          v: status.structure_seed_source || '—',
          bad:
            status.mode === 'LIVE' &&
            !!status.capital_live_attached &&
            !!status.structure_seed_source &&
            status.structure_seed_source !== 'capital_ohlc' &&
            status.structure_seed_source !== 'none',
          ok:
            !status.capital_live_attached ||
            !status.structure_seed_source ||
            status.structure_seed_source === 'capital_ohlc' ||
            status.structure_seed_source === 'none',
        },
        {
          k: 'Bars cache',
          v: String(status.bars_available ?? 0),
          bad: (status.bars_available ?? 0) < 40,
          ok: (status.bars_available ?? 0) >= 40,
        },
        { k: 'AI mode', v: status.ai_mode || '—' },
        {
          k: 'Close fail',
          v: status.last_close_failed
            ? `${status.last_close_failed.exit_reason} · ${status.last_close_failed.detail}`.slice(
                0,
                80
              )
            : '—',
          bad: !!status.last_close_failed,
        },
        { k: 'Running', v: status.running ? 'YES' : 'NO', ok: status.running },
        { k: 'Regime', v: status.regime },
        {
          k: 'Norm',
          v: status.last_market
            ? `Q=${status.last_market.quality.toFixed(2)} · ${status.last_market.bars_out}/${status.last_market.bars_in}${
                status.last_market.reasons.length
                  ? ` · ${status.last_market.reasons.slice(0, 2).join('|')}`
                  : ''
              }`
            : '—',
          bad: !!status.last_market && (!status.last_market.ok || status.last_market.quality < 0.5),
          ok: !!status.last_market?.ok && (status.last_market.quality ?? 0) >= 0.5,
        },
        { k: 'BUY', v: Number(status.buy_score || 0).toFixed(3) },
        { k: 'SELL', v: Number(status.sell_score || 0).toFixed(3) },
        { k: 'Decision', v: status.last_decision?.kind || '—' },
        {
          k: 'Why',
          v: why,
          bad:
            !!status.last_block_reason ||
            !!status.monitoring?.entry_block_reason ||
            (!!status.expectancy_gate_armed &&
              (status.expectancy_would_block?.length || 0) > 0),
        },
        ...(wouldGateNote
          ? [
              {
                k: 'Exp advisory',
                v: wouldGateNote,
                bad: false,
                ok: false,
              } as { k: string; v: string; bad?: boolean; ok?: boolean },
            ]
          : []),
        {
          k: 'Entry gates',
          v: status.entry_gates
            ? [
                status.entry_gates.weekend ? 'weekend' : null,
                status.entry_gates.session_blocks
                  ? `session=${status.entry_gates.session}`
                  : `session=${status.entry_gates.session}`,
                status.entry_gates.hours_ok ? 'hoursOK' : 'hoursBLOCK',
                status.entry_gates.news_cfg_on
                  ? status.entry_gates.news_blocks
                    ? `newsBLOCK${status.entry_gates.news_detail ? `·${status.entry_gates.news_detail}` : ''}`
                    : 'newsClear'
                  : 'newsOff',
              ]
                .filter(Boolean)
                .join(' · ')
            : '—',
          bad:
            !!status.entry_gates &&
            (status.entry_gates.weekend ||
              status.entry_gates.session_blocks ||
              !status.entry_gates.hours_ok ||
              status.entry_gates.news_blocks),
          ok:
            !!status.entry_gates &&
            !status.entry_gates.weekend &&
            !status.entry_gates.session_blocks &&
            status.entry_gates.hours_ok &&
            !status.entry_gates.news_blocks,
        },
        { k: 'Last exit', v: status.last_exit_reason || '—' },
        {
          k: 'Equity',
          v:
            status.capital_account_proven === false
              ? 'UNPROVEN'
              : status.account?.equity != null
                ? Number(status.account.equity).toFixed(2)
                : '—',
          bad: status.capital_account_proven === false,
        },
        {
          k: 'Available',
          v:
            status.capital_account_proven === false
              ? '—'
              : status.account?.available_to_deal != null
                ? Number(status.account.available_to_deal).toFixed(2)
                : '—',
        },
        {
          k: 'Trade allowed',
          v:
            status.account?.trade_allowed === false
              ? 'NO'
              : status.account?.trade_allowed === true
                ? 'YES'
                : '—',
          bad: status.account?.trade_allowed === false,
          ok: status.account?.trade_allowed === true,
        },
        {
          k: 'Account proven',
          v:
            status.capital_account_proven === false
              ? 'NO'
              : status.capital_account_proven === true
                ? 'YES'
                : '—',
          bad: status.capital_account_proven === false,
          ok: status.capital_account_proven === true,
        },
        {
          k: 'News',
          v: status.news_window?.window_active
            ? `${status.news_window.impact} · ${status.news_window.source}`
            : 'clear',
          bad: !!status.news_window?.window_active && status.news_window?.impact === 'high',
        },
        {
          k: 'Daily PnL',
          v:
            status.capital_account_proven === false
              ? '—'
              : status.account?.daily_pnl != null
                ? Number(status.account.daily_pnl).toFixed(2)
                : '—',
        },
        {
          k: 'Day start eq',
          v:
            status.capital_account_proven === false
              ? 'UNPROVEN'
              : status.account?.day_start_equity != null
                ? Number(status.account.day_start_equity).toFixed(2)
                : '—',
          bad: status.capital_account_proven === false,
        },
        {
          k: 'Peak eq',
          v:
            status.capital_account_proven === false
              ? 'UNPROVEN'
              : status.account?.peak_equity != null
                ? Number(status.account.peak_equity).toFixed(2)
                : '—',
          bad: status.capital_account_proven === false,
        },
        {
          k: 'Reject cool',
          v:
            (status.reject_cooldown_ms ?? 0) > 0
              ? `${Math.ceil((status.reject_cooldown_ms || 0) / 1000)}s`
              : '—',
          bad: (status.reject_cooldown_ms ?? 0) > 0,
        },
        { k: 'Open', v: String(status.open_positions) },
        {
          k: 'Venue',
          v:
            status.capital_live_attached
              ? status.capital_venue_opens_proven === false
                ? 'unproven'
                : String(status.capital_venue_opens ?? 0)
              : '—',
          bad:
            !!status.capital_live_attached &&
            (status.capital_venue_opens_proven === false ||
              (status.capital_venue_opens ?? 0) > 0),
        },
        { k: 'Trades', v: String(status.traded) },
        { k: 'Blocked', v: String(status.blocked) },
        {
          k: 'Expectancy',
          v: status.performance?.trades
            ? Number(status.performance?.expectancy || 0).toFixed(3)
            : '—',
        },
        {
          k: 'Fees',
          v:
            status.performance?.trades
              ? Number(status.performance.total_fees || 0).toFixed(2)
              : '—',
        },
        {
          k: 'Win rate',
          v: status.performance?.trades
            ? `${(Number(status.performance.win_rate || 0) * 100).toFixed(1)}%`
            : '—',
        },
        {
          k: 'Profit factor',
          v: status.performance?.trades
            ? status.performance?.profit_factor != null &&
              Number.isFinite(status.performance.profit_factor)
              ? Number(status.performance.profit_factor).toFixed(2)
              : '—'
            : '—',
        },
        {
          k: 'Loss streak',
          v:
            status.capital_account_proven === false
              ? '—'
              : status.account?.consecutive_losses != null
                ? String(status.account.consecutive_losses)
                : '—',
          bad:
            status.capital_account_proven !== false &&
            (status.account?.consecutive_losses || 0) >= 3,
        },
        {
          k: 'MC eq p05/p50/p95',
          v:
            status.monte_carlo?.equity_p50 != null
              ? `${Number(status.monte_carlo.equity_p05 ?? 0).toFixed(1)} / ${Number(
                  status.monte_carlo.equity_p50
                ).toFixed(1)} / ${Number(status.monte_carlo.equity_p95 ?? 0).toFixed(1)}`
              : status.monte_carlo?.p50 != null
                ? `${Number(status.monte_carlo.p05 ?? 0).toFixed(1)} / ${Number(
                    status.monte_carlo.p50
                  ).toFixed(1)} / ${Number(status.monte_carlo.p95 ?? 0).toFixed(1)}`
                : '—',
        },
        {
          k: 'MC DD p50/p95',
          v:
            status.monte_carlo?.drawdown_p50 != null
              ? `${Number(status.monte_carlo.drawdown_p50).toFixed(1)} / ${Number(
                  status.monte_carlo.drawdown_p95 ?? 0
                ).toFixed(1)}`
              : '—',
        },
        {
          k: 'Rel spread',
          v:
            status.monitoring?.relative_spread != null
              ? Number(status.monitoring.relative_spread).toFixed(2)
              : '—',
          bad:
            status.monitoring?.relative_spread != null &&
            status.monitoring.relative_spread > 1.5,
        },
        {
          k: 'Cycle ms',
          v:
            status.monitoring?.last_cycle_ms != null
              ? String(status.monitoring.last_cycle_ms)
              : '—',
        },
        {
          k: 'ACK ms',
          v:
            status.monitoring?.ack_latency_ms != null
              ? String(status.monitoring.ack_latency_ms)
              : '—',
        },
        {
          k: 'Health',
          v: status.monitoring?.instance_health || '—',
          bad:
            status.monitoring?.instance_health === 'CRITICAL' ||
            status.monitoring?.instance_health === 'DEGRADED',
          ok: status.monitoring?.instance_health === 'OK',
        },
        {
          k: 'Alert block',
          v: status.monitoring?.entry_block_reason || '—',
          bad: !!status.monitoring?.entry_block_reason,
        },
        {
          k: 'Alerts',
          v: status.monitoring?.active_alerts?.length
            ? status.monitoring.active_alerts
                .slice(0, 3)
                .map((a) => a.code)
                .join(' · ')
            : '—',
          bad: (status.monitoring?.active_alerts?.length || 0) > 0,
        },
        {
          k: 'Err/min',
          v:
            status.monitoring?.error_rate_per_min != null
              ? String(status.monitoring.error_rate_per_min)
              : '—',
          bad: (status.monitoring?.error_rate_per_min || 0) > 0,
        },
        {
          k: 'Max DD',
          v: status.performance?.trades
            ? Number(status.performance?.max_drawdown || 0).toFixed(2)
            : '—',
        },
        { k: 'Recovered', v: status.recovered ? 'YES' : '—' },
        {
          k: 'Persist',
          v: status.persist_ok === false ? 'DEGRADED' : 'OK',
          bad: status.persist_ok === false,
          ok: status.persist_ok !== false,
        },
        {
          k: 'Persist err',
          v: status.last_persist_error || '—',
          bad: !!status.last_persist_error,
        },
        {
          k: 'Last error',
          v: status.recent_errors?.[0]
            ? `${status.recent_errors[0].error_type}: ${status.recent_errors[0].message}`.slice(
                0,
                72
              )
            : '—',
          bad: !!status.recent_errors?.length,
        },
      ]
    : [];

  return (
    <div>
      <h1 className="page-title">VS MASTER</h1>
      <p style={{ color: 'var(--text-secondary)', marginTop: -8, marginBottom: 16, fontSize: 13 }}>
        Primary LIVE = Capital.com API (direct) · MT4 logic ported into MASTER (not a bridge) ·
        scores heuristic — not probability · LIVE gated unless MASTER_LIVE_ENABLED
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Epic{' '}
          <input
            value={epicInput}
            onChange={(e) => setEpicInput(e.target.value.toUpperCase())}
            style={{ width: 90, marginLeft: 4, padding: '4px 6px' }}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('epic', () =>
              apiFetch('/api/master/control', {
                method: 'POST',
                body: JSON.stringify({ epic: epicInput }),
              })
            )
          }
        >
          Set epic
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            busy ||
            (!!status?.capital_live_attached &&
              ((status?.open_positions ?? 0) > 0 ||
                (status?.capital_venue_opens ?? 0) > 0 ||
                status?.capital_venue_opens_proven === false))
          }
          title={
            status?.capital_live_attached &&
            ((status?.open_positions ?? 0) > 0 ||
              (status?.capital_venue_opens ?? 0) > 0 ||
              status?.capital_venue_opens_proven === false)
              ? 'Flatten all Capital opens before Start PAPER'
              : undefined
          }
          onClick={() =>
            void act('start', async () => {
              await apiFetch('/api/master/control', {
                method: 'POST',
                body: JSON.stringify({ mode: 'PAPER', epic: epicInput }),
              });
              return apiFetch('/api/master/start', {
                method: 'POST',
                body: JSON.stringify({ mode: 'PAPER' }),
              });
            })
          }
        >
          Start PAPER
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('start-live', async () => {
              // Capital LIVE single-owner — enable owns before arming LIVE
              if (!status?.owns_pipeline) {
                await apiFetch('/api/master/control', {
                  method: 'POST',
                  body: JSON.stringify({ owns_pipeline: true }),
                });
              }
              await apiFetch('/api/master/control', {
                method: 'POST',
                body: JSON.stringify({ mode: 'LIVE', epic: epicInput }),
              });
              const r = await apiFetch<{
                ok?: boolean;
                detail?: string;
                status?: { mode?: string };
              }>('/api/master/start', {
                method: 'POST',
                body: JSON.stringify({ mode: 'LIVE' }),
              });
              if (r && r.ok === false) {
                await apiFetch('/api/master/control', {
                  method: 'POST',
                  body: JSON.stringify({ mode: 'PAPER' }),
                });
              }
              return r;
            })
          }
        >
          Start LIVE (Capital)
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void act('stop', () => apiFetch('/api/master/stop', { method: 'POST' }))}
        >
          Stop
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('recover', () => apiFetch('/api/master/recover', { method: 'POST' }))
          }
        >
          Recover
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('kill', () =>
              apiFetch('/api/master/control', {
                method: 'POST',
                body: JSON.stringify({ kill_switch: !status?.kill_switch }),
              })
            )
          }
        >
          Kill switch
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('scalp-preset', () =>
              apiFetch('/api/master/config/scalp-preset', { method: 'POST' })
            )
          }
        >
          Arm SCALP manage
        </button>
        <button
          type="button"
          className="btn"
          disabled={
            busy ||
            (positions.length === 0 &&
              (status?.capital_venue_opens ?? 0) === 0 &&
              status?.capital_venue_opens_proven !== false)
          }
          onClick={() =>
            void act('flatten', () => apiFetch('/api/master/flatten', { method: 'POST' }))
          }
        >
          Flatten all
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('ai', () => {
              const cur = status?.ai_mode || 'off';
              const next =
                cur === 'off'
                  ? 'advisory'
                  : cur === 'advisory'
                    ? 'required'
                    : 'off';
              return apiFetch('/api/master/control', {
                method: 'POST',
                body: JSON.stringify({ ai_mode: next }),
              });
            })
          }
        >
          AI mode cycle
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('owns', () =>
              apiFetch('/api/master/control', {
                method: 'POST',
                body: JSON.stringify({ owns_pipeline: !status?.owns_pipeline }),
              })
            )
          }
        >
          {status?.owns_pipeline ? 'MASTER owns ON' : 'MASTER owns OFF'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('capital-probe', () =>
              apiFetch('/api/master/broker/capital/probe', { method: 'POST' })
            )
          }
        >
          Capital probe
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('capital-attach', async () => {
              if (!status?.owns_pipeline) {
                await apiFetch('/api/master/control', {
                  method: 'POST',
                  body: JSON.stringify({ owns_pipeline: true }),
                });
              }
              return apiFetch('/api/master/broker/capital/attach', {
                method: 'POST',
                body: '{}',
              });
            })
          }
        >
          Attach Capital
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act('mt4-attach', () =>
              apiFetch('/api/master/broker/mt4', { method: 'POST', body: '{}' })
            )
          }
        >
          MT4 legacy
        </button>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 12, color: 'var(--bad, #c44)' }}>
          {error}
        </div>
      )}

      <div className="grid grid-4" style={{ gap: 10, marginBottom: 20 }}>
        {cards.map((c) => (
          <div key={c.k} className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>
              {c.k.toUpperCase()}
            </div>
            <div
              style={{
                marginTop: 6,
                fontWeight: 600,
                wordBreak: 'break-word',
                color: c.bad ? 'var(--bad, #c44)' : c.ok ? 'var(--ok, #2a7)' : undefined,
              }}
            >
              {c.v}
            </div>
          </div>
        ))}
      </div>

      <h2 className="section-title">Manage config</h2>
      <div className="card" style={{ marginBottom: 20, padding: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <label style={{ fontSize: 12 }}>
            min_score{' '}
            <input
              type="number"
              step="0.05"
              min={0}
              max={1}
              defaultValue={status?.manage?.min_score ?? 0.55}
              id="cfg-min-score"
              style={{ width: 64 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            be_start{' '}
            <input
              type="number"
              step="0.1"
              min={0}
              defaultValue={status?.manage?.be_start ?? 0}
              id="cfg-be-start"
              style={{ width: 64 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            trail_start{' '}
            <input
              type="number"
              step="0.1"
              min={0}
              defaultValue={status?.manage?.trail_start ?? 0}
              id="cfg-trail-start"
              style={{ width: 64 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            trail_lock{' '}
            <input
              type="number"
              step="0.1"
              min={0}
              defaultValue={status?.manage?.trail_lock ?? 0}
              id="cfg-trail-lock"
              style={{ width: 64 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            partial_prog{' '}
            <input
              type="number"
              step="0.05"
              min={0}
              max={1}
              defaultValue={status?.manage?.partial_close_progress ?? 0.5}
              id="cfg-partial-prog"
              style={{ width: 56 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            partial_vol{' '}
            <input
              type="number"
              step="0.05"
              min={0}
              max={1}
              defaultValue={status?.manage?.partial_close_volume ?? 0.5}
              id="cfg-partial-vol"
              style={{ width: 56 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            close_all_profit{' '}
            <input
              type="number"
              step="1"
              min={0}
              defaultValue={status?.manage?.close_all_profit ?? 0}
              id="cfg-close-all-profit"
              style={{ width: 72 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            close_all_loss{' '}
            <input
              type="number"
              step="1"
              min={0}
              defaultValue={status?.manage?.close_all_loss ?? 0}
              id="cfg-close-all-loss"
              style={{ width: 72 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            max_hold_min{' '}
            <input
              type="number"
              step="1"
              min={0}
              defaultValue={Math.round((status?.manage?.max_hold_ms ?? 0) / 60_000)}
              id="cfg-max-hold-min"
              style={{ width: 56 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            daily_loss_limit{' '}
            <input
              type="number"
              step="10"
              min={0}
              defaultValue={status?.manage?.daily_loss_limit ?? 0}
              id="cfg-daily-loss"
              style={{ width: 72 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            be_money{' '}
            <input
              type="number"
              step="0.01"
              min={0}
              defaultValue={status?.manage?.breakeven_activation_money ?? 0}
              id="cfg-be-money"
              style={{ width: 64 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            soft_trail_arm{' '}
            <input
              type="number"
              step="0.01"
              min={0}
              defaultValue={status?.manage?.soft_trail_money_arm ?? 0}
              id="cfg-soft-arm"
              style={{ width: 64 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            soft_trail_pips{' '}
            <input
              type="number"
              step="0.1"
              min={0}
              defaultValue={status?.manage?.soft_trail_pips ?? 0.3}
              id="cfg-soft-pips"
              style={{ width: 56 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              id="cfg-scalp-chase"
              defaultChecked={!!status?.manage?.scalp_pct_chase}
            />{' '}
            scalp_pct_chase
          </label>
          <label style={{ fontSize: 12 }}>
            multi_tp{' '}
            <input
              type="number"
              step="1"
              min={0}
              max={5}
              defaultValue={status?.manage?.multi_tp_count ?? 0}
              id="cfg-multi-tp"
              style={{ width: 48 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              id="cfg-exp-gate"
              defaultChecked={!!status?.manage?.require_positive_expectancy}
            />{' '}
            require_positive_expectancy
          </label>
          <label style={{ fontSize: 12 }}>
            min_samples{' '}
            <input
              type="number"
              step="1"
              min={1}
              defaultValue={status?.manage?.min_expectancy_samples ?? 20}
              id="cfg-exp-samples"
              style={{ width: 56 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              id="cfg-news"
              defaultChecked={status?.manage?.block_high_impact_news !== false}
            />{' '}
            block news
          </label>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              id="cfg-hours"
              defaultChecked={status?.manage?.block_off_hours !== false}
            />{' '}
            block off-hours
          </label>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void act('patch-config', () => {
                const num = (id: string) => {
                  const el = document.getElementById(id) as HTMLInputElement | null;
                  return el ? Number(el.value) : undefined;
                };
                const chk = (id: string) => {
                  const el = document.getElementById(id) as HTMLInputElement | null;
                  return !!el?.checked;
                };
                return apiFetch('/api/master/config', {
                  method: 'PATCH',
                  body: JSON.stringify({
                    min_score: num('cfg-min-score'),
                    be_start: num('cfg-be-start'),
                    trail_start: num('cfg-trail-start'),
                    trail_lock: num('cfg-trail-lock'),
                    partial_close_progress: num('cfg-partial-prog'),
                    partial_close_volume: num('cfg-partial-vol'),
                    close_all_profit: num('cfg-close-all-profit'),
                    close_all_loss: num('cfg-close-all-loss'),
                    max_hold_ms: (() => {
                      const m = num('cfg-max-hold-min');
                      return m != null && Number.isFinite(m) ? Math.max(0, m) * 60_000 : undefined;
                    })(),
                    breakeven_activation_money: num('cfg-be-money'),
                    daily_loss_limit: num('cfg-daily-loss'),
                    soft_trail_money_arm: num('cfg-soft-arm'),
                    soft_trail_pips: num('cfg-soft-pips'),
                    scalp_pct_chase: chk('cfg-scalp-chase'),
                    multi_tp_count: num('cfg-multi-tp'),
                    require_positive_expectancy: chk('cfg-exp-gate'),
                    min_expectancy_samples: num('cfg-exp-samples'),
                    block_high_impact_news: chk('cfg-news'),
                    block_off_hours: chk('cfg-hours'),
                  }),
                });
              })
            }
          >
            Save manage knobs
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void act('replay-status-bars', async () => {
                const snap = await apiFetch<{
                  ok?: boolean;
                  count?: number;
                  bars?: Array<{
                    open: number;
                    high: number;
                    low: number;
                    close: number;
                    ts_ms: number;
                  }>;
                }>('/api/master/bars?limit=120');
                const bars = snap.bars || [];
                if (bars.length < 40) {
                  setReplayNote(
                    `replay refused — need ≥40 cached bars (have ${snap.count ?? 0}). Start PAPER/LIVE feed first.`
                  );
                  return { ok: false, detail: 'insufficient_cached_bars' };
                }
                const r = await apiFetch<{
                  ok?: boolean;
                  detail?: string;
                  performance?: { trades?: number; expectancy?: number; total_pnl?: number };
                  traded?: number;
                  equity_end?: number;
                }>('/api/master/replay', {
                  method: 'POST',
                  body: JSON.stringify({ bars }),
                });
                setReplayNote(
                  r.ok
                    ? `replay [live_cache n=${bars.length}] trades=${
                        r.traded ?? r.performance?.trades ?? 0
                      } EV=${(r.performance?.expectancy ?? 0).toFixed(3)} pnl=${(
                        r.performance?.total_pnl ?? 0
                      ).toFixed(2)} end=${r.equity_end ?? '—'}`
                    : r.detail || 'replay failed'
                );
                return r;
              })
            }
          >
            Replay (cached bars)
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void act('walk-forward-status-bars', async () => {
                const snap = await apiFetch<{
                  ok?: boolean;
                  count?: number;
                  bars?: Array<{
                    open: number;
                    high: number;
                    low: number;
                    close: number;
                    ts_ms: number;
                  }>;
                }>('/api/master/bars?limit=200');
                const bars = snap.bars || [];
                if (bars.length < 120) {
                  setReplayNote(
                    `walk-forward refused — need ≥120 cached bars (have ${snap.count ?? 0}). Start PAPER/LIVE feed first.`
                  );
                  return { ok: false, detail: 'insufficient_cached_bars' };
                }
                const r = await apiFetch<{
                  ok?: boolean;
                  detail?: string;
                  windows?: Array<{
                    in_sample?: { trades?: number; expectancy?: number };
                    out_of_sample?: { trades?: number; expectancy?: number };
                  }>;
                }>('/api/master/walk-forward', {
                  method: 'POST',
                  body: JSON.stringify({ bars, train: 60, test: 30, step: 40 }),
                });
                const n = r.windows?.length ?? 0;
                const last = r.windows?.[n - 1];
                setReplayNote(
                  r.ok
                    ? `walk-forward [live_cache n=${bars.length}] windows=${n} last IS EV=${(
                        last?.in_sample?.expectancy ?? 0
                      ).toFixed(3)} OOS EV=${(
                        last?.out_of_sample?.expectancy ?? 0
                      ).toFixed(3)}`
                    : r.detail || 'walk-forward failed'
                );
                return r;
              })
            }
          >
            Walk-forward
          </button>
        </div>
        {replayNote && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
            {replayNote}
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
          Live manage: scalp={String(!!status?.manage?.scalp_pct_chase)} softTrail=
          {status?.manage?.soft_trail_money_arm ?? '—'} multiTP=
          {status?.manage?.multi_tp_count ?? 0} expGate=
          {String(!!status?.manage?.require_positive_expectancy)}
        </div>
      </div>

      <h2 className="section-title">Open positions</h2>
      <div className="grid grid-3" style={{ gap: 10, marginBottom: 20 }}>
        {positions.length === 0 ? (
          <div className="card">FLAT</div>
        ) : (
          positions.map((p) => {
            const upl = p.upl != null && Number.isFinite(Number(p.upl)) ? Number(p.upl) : null;
            return (
              <div key={p.position_id} className="card">
                <div style={{ fontWeight: 600, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>
                    {p.side} {p.epic}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() =>
                      void act('close', () =>
                        apiFetch(`/api/master/positions/${encodeURIComponent(p.position_id)}/close`, {
                          method: 'POST',
                        })
                      )
                    }
                  >
                    Close
                  </button>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>
                  {Number(p.entry).toFixed(2)}
                  {p.mark != null ? ` → ${Number(p.mark).toFixed(2)}` : ''} · sz {p.size}
                  {p.stop_loss != null && Number(p.stop_loss) > 0
                    ? ` · SL ${Number(p.stop_loss).toFixed(2)}`
                    : ' · SL —'}
                  {p.take_profit != null && Number(p.take_profit) > 0
                    ? ` · TP ${Number(p.take_profit).toFixed(2)}`
                    : ''}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    marginTop: 4,
                    color:
                      upl == null
                        ? 'var(--text-secondary)'
                        : upl >= 0
                          ? 'var(--ok, #2a7)'
                          : 'var(--bad, #c44)',
                  }}
                >
                  UPL {upl != null ? upl.toFixed(2) : '—'} · MFE {Number(p.mfe).toFixed(2)} · MAE{' '}
                  {Number(p.mae).toFixed(2)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {[
                    p.native_trail_armed ? 'nativeTrail' : null,
                    p.soft_trail_armed_at ? 'softTrail' : null,
                    p.partial_close_applied ? 'partial' : null,
                    Array.isArray(p.multi_tp_levels) && p.multi_tp_levels.length
                      ? `multiTP×${p.multi_tp_levels.length}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'manage: structure/MFE'}
                </div>
              </div>
            );
          })
        )}
      </div>

      <h2 className="section-title">Decision journal (recent cycles)</h2>
      <div className="grid grid-3" style={{ gap: 10, marginBottom: 20 }}>
        {!status?.recent_decisions?.length ? (
          <div className="card">no cycle events yet</div>
        ) : (
          status.recent_decisions.map((d, i) => (
            <div key={`${d.ts}-${i}`} className="card">
              <div style={{ fontWeight: 600 }}>
                {d.kind}
                {d.executed ? ' · FILL' : ''}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                {d.block_reason
                  ? String(d.block_reason).slice(0, 56)
                  : d.execution_detail
                    ? String(d.execution_detail).slice(0, 56)
                    : '—'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                B {(d.buy_score ?? 0).toFixed(2)} / S {(d.sell_score ?? 0).toFixed(2)}
                {d.ts ? ` · ${new Date(d.ts).toISOString().slice(11, 19)}` : ''}
                {d.opportunity_id
                  ? ` · opp ${String(d.opportunity_id).slice(0, 8)}`
                  : ''}
              </div>
            </div>
          ))
        )}
      </div>

      <h2 className="section-title">Trade events (OPEN/MODIFY/CLOSE)</h2>
      <div className="grid grid-3" style={{ gap: 10, marginBottom: 20 }}>
        {!status?.recent_trades?.length ? (
          <div className="card">no trade events yet</div>
        ) : (
          status.recent_trades.map((t, i) => {
            // OPEN/MODIFY normally have null pnl — only CLOSE (or explicit
            // unproven detail) is UNPROVEN, never forged £0 on opens.
            const ev = String(t.event || '').toUpperCase();
            const unproven =
              (ev === 'CLOSE' && t.pnl == null) ||
              /pnl_unproven|capital_close_pnl_unproven/i.test(
                String(t.detail || '')
              );
            return (
            <div key={`${t.ts}-${i}`} className="card">
              <div style={{ fontWeight: 600 }}>
                {t.event} · {t.broker}
                {!t.ok ? ' · FAIL' : ''}
                {unproven && t.ok ? ' · UNPROVEN' : ''}
              </div>
              <div
                style={{
                  fontSize: 13,
                  marginTop: 4,
                  color: unproven
                    ? 'var(--text-secondary)'
                    : t.pnl != null
                      ? t.pnl >= 0
                        ? 'var(--ok, #2a7)'
                        : 'var(--bad, #c44)'
                      : 'var(--text-secondary)',
                }}
              >
                {unproven ? '—' : t.pnl != null ? t.pnl.toFixed(2) : '—'}
                {!unproven && t.fees != null && t.fees > 0
                  ? ` · fees ${Number(t.fees).toFixed(2)}`
                  : ''}
                {t.detail ? ` · ${String(t.detail).slice(0, 40)}` : ''}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                {t.ts ? new Date(t.ts).toISOString().slice(11, 19) : '—'}
                {t.opportunity_id
                  ? ` · opp ${String(t.opportunity_id).slice(0, 8)}`
                  : ''}
              </div>
            </div>
            );
          })
        )}
      </div>

      <h2 className="section-title">Setup expectancy</h2>
      <div className="grid grid-3" style={{ gap: 10, marginBottom: 20 }}>
        {setupEv.length === 0 ? (
          <div className="card">no setup samples yet</div>
        ) : (
          setupEv.slice(0, 12).map((e) => {
            const minN = status?.manage?.min_expectancy_samples ?? 20;
            const wouldGate = e.samples >= minN && !e.positive;
            const gateOn = !!status?.manage?.require_positive_expectancy;
            const gateHit = gateOn && wouldGate;
            return (
              <div key={e.setup_key} className="card">
                <div style={{ fontWeight: 600, fontSize: 12 }}>{e.setup_key}</div>
                <div
                  style={{
                    fontSize: 13,
                    marginTop: 4,
                    color: gateHit
                      ? 'var(--bad, #c44)'
                      : wouldGate
                        ? 'var(--bad, #c44)'
                        : e.positive
                          ? 'var(--ok, #2a7)'
                          : 'var(--text-secondary)',
                  }}
                >
                  EV {e.ev.toFixed(3)} · n={e.samples}
                  {e.positive ? ' · +' : ' · −'}
                  {gateHit ? ' · GATE' : wouldGate ? ' · WOULD_GATE' : ''}
                </div>
              </div>
            );
          })
        )}
      </div>

      <h2 className="section-title">Journal (recent traded)</h2>
      <div className="grid grid-3" style={{ gap: 10, marginBottom: 20 }}>
        {journal.length === 0 ? (
          <div className="card">no closed trades yet</div>
        ) : (
          journal.map((o) => {
            const unproven = o.outcome?.pnl_proven === false;
            const pn = Number(o.outcome?.pnl ?? 0);
            return (
              <div key={o.id} className="card">
                <div style={{ fontWeight: 600 }}>
                  {o.decision?.side || o.decision?.kind} {o.epic}
                  {unproven ? ' · UNPROVEN' : ''}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: unproven
                      ? 'var(--text-secondary)'
                      : pn >= 0
                        ? 'var(--ok, #2a7)'
                        : 'var(--bad, #c44)',
                  }}
                >
                  {unproven ? '—' : pn.toFixed(2)} ·{' '}
                  {String(o.outcome?.exit_reason || '').slice(0, 48)}
                  {o.outcome?.r_multiple != null
                    ? ` · R ${Number(o.outcome.r_multiple).toFixed(2)}`
                    : ''}
                </div>
              </div>
            );
          })
        )}
      </div>

      {blockedJournal.length > 0 && (
        <>
          <h2 className="section-title">Journal (recent WAIT/BLOCK)</h2>
          <div className="grid grid-3" style={{ gap: 10, marginBottom: 20 }}>
            {blockedJournal.map((o) => (
              <div key={o.id} className="card">
                <div style={{ fontWeight: 600 }}>
                  {o.decision?.kind || 'WAIT'} {o.epic}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {String(
                    o.block_reason || o.decision?.block_reason || 'blocked'
                  ).slice(0, 64)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">Activity</h2>
      <pre
        className="card"
        style={{
          fontSize: 12,
          maxHeight: 180,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          color: 'var(--text-secondary)',
        }}
      >
        {log.join('\n') || '—'}
      </pre>
    </div>
  );
}
