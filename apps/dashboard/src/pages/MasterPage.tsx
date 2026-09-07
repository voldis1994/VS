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
  last_decision: { kind?: string } | null;
  last_block_reason: string | null;
  last_execution_detail: string | null;
  last_exit_reason: string | null;
  buy_score: number;
  sell_score: number;
  regime: string;
  market_state: string;
  account: {
    equity: number;
    balance: number;
    daily_pnl: number;
    available_to_deal?: number | null;
  } | null;
  open_positions: number;
  performance: { expectancy?: number; max_drawdown?: number; trades?: number } | null;
  opportunities: number;
  traded: number;
  blocked: number;
  health: string;
  recovered: boolean;
  persist_ok: boolean;
  last_persist_error: string | null;
  entries_armed: boolean;
  entries_pause_reason: string | null;
  news_window?: {
    impact: string;
    window_active: boolean;
    source: string;
    detail: string;
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
};

type JournalOpp = {
  id: string;
  epic: string;
  executed: boolean;
  decision?: { kind?: string };
  outcome?: { pnl: number; exit_reason: string; position_id?: string };
};

export function MasterPage() {
  const [status, setStatus] = useState<MasterStatus | null>(null);
  const [positions, setPositions] = useState<ManagedPos[]>([]);
  const [journal, setJournal] = useState<JournalOpp[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [epicInput, setEpicInput] = useState('GOLD');

  const pushLog = useCallback((msg: string) => {
    const t = new Date().toISOString().slice(11, 19);
    setLog((prev) => [`[${t}] ${msg}`, ...prev].slice(0, 40));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, p, j] = await Promise.all([
        apiFetch<MasterStatus>('/api/master/status'),
        apiFetch<{ positions: ManagedPos[] }>('/api/master/positions'),
        apiFetch<{ opportunities: JournalOpp[] }>('/api/master/journal'),
      ]);
      setStatus(s);
      if (s.epic) setEpicInput(s.epic);
      setPositions(p.positions || []);
      setJournal((j.opportunities || []).filter((o) => o.executed && o.outcome).slice(-8).reverse());
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
      pushLog(`${label} ${JSON.stringify(r)}`);
      await refresh();
    } catch (e) {
      pushLog(`${label} error ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const why =
    status?.last_block_reason ||
    status?.last_execution_detail ||
    status?.last_decision?.kind ||
    '—';
  const healthBad =
    !!status?.health?.includes('KILL') ||
    status?.health === 'PERSIST_DEGRADED' ||
    status?.persist_ok === false;

  const cards: Array<{ k: string; v: string; bad?: boolean; ok?: boolean }> = status
    ? [
        { k: 'Mode', v: status.mode },
        { k: 'Epic', v: status.epic || '—' },
        { k: 'Health', v: status.health, bad: healthBad, ok: !healthBad },
        { k: 'Broker', v: status.broker || '—' },
        { k: 'Broker detail', v: status.broker_detail || '—' },
        { k: 'Owns pipeline', v: status.owns_pipeline ? 'YES' : 'no' },
        {
          k: 'Entries',
          v: status.entries_armed === false
            ? `PAUSED${status.entries_pause_reason ? ` · ${status.entries_pause_reason}` : ''}`
            : 'armed',
          bad: status.entries_armed === false,
          ok: status.entries_armed !== false,
        },
        { k: 'AI mode', v: status.ai_mode || '—' },
        { k: 'Running', v: status.running ? 'YES' : 'NO', ok: status.running },
        { k: 'Regime', v: status.regime },
        { k: 'BUY', v: Number(status.buy_score || 0).toFixed(3) },
        { k: 'SELL', v: Number(status.sell_score || 0).toFixed(3) },
        { k: 'Decision', v: status.last_decision?.kind || '—' },
        { k: 'Why', v: why, bad: !!status.last_block_reason },
        { k: 'Last exit', v: status.last_exit_reason || '—' },
        {
          k: 'Equity',
          v: status.account?.equity != null ? Number(status.account.equity).toFixed(2) : '—',
        },
        {
          k: 'Available',
          v:
            status.account?.available_to_deal != null
              ? Number(status.account.available_to_deal).toFixed(2)
              : '—',
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
          v: status.account?.daily_pnl != null ? Number(status.account.daily_pnl).toFixed(2) : '—',
        },
        { k: 'Open', v: String(status.open_positions) },
        { k: 'Trades', v: String(status.traded) },
        { k: 'Blocked', v: String(status.blocked) },
        {
          k: 'Expectancy',
          v: Number(status.performance?.expectancy || 0).toFixed(3),
        },
        {
          k: 'Max DD',
          v: Number(status.performance?.max_drawdown || 0).toFixed(2),
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
      ]
    : [];

  return (
    <div>
      <h1 className="page-title">VS MASTER</h1>
      <p style={{ color: 'var(--text-secondary)', marginTop: -8, marginBottom: 16, fontSize: 13 }}>
        Single authoritative pipeline · scores are heuristic — not probability · LIVE gated unless
        MASTER_LIVE_ENABLED
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
          disabled={busy}
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
              // Server resets mode on refuse; reinforce so UI never sticks on LIVE_ARMED
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
          Start LIVE
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
            void act('ai', () =>
              apiFetch('/api/master/control', {
                method: 'POST',
                body: JSON.stringify({
                  ai_mode: status?.ai_mode === 'off' ? 'advisory' : 'off',
                }),
              })
            )
          }
        >
          AI advisory toggle
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
            void act('mt4-attach', () =>
              apiFetch('/api/master/broker/mt4', { method: 'POST', body: '{}' })
            )
          }
        >
          Attach MT4
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

      <h2 className="section-title">Open positions</h2>
      <div className="grid grid-3" style={{ gap: 10, marginBottom: 20 }}>
        {positions.length === 0 ? (
          <div className="card">FLAT</div>
        ) : (
          positions.map((p) => (
            <div key={p.position_id} className="card">
              <div style={{ fontWeight: 600 }}>
                {p.side} {p.epic}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {Number(p.entry).toFixed(2)} · sz {p.size} · MFE {Number(p.mfe).toFixed(2)}
                {p.stop_loss != null ? ` · SL ${Number(p.stop_loss).toFixed(2)}` : ' · SL —'}
              </div>
            </div>
          ))
        )}
      </div>

      <h2 className="section-title">Journal (recent traded)</h2>
      <div className="grid grid-3" style={{ gap: 10, marginBottom: 20 }}>
        {journal.length === 0 ? (
          <div className="card">no closed trades yet</div>
        ) : (
          journal.map((o) => {
            const pn = Number(o.outcome?.pnl ?? 0);
            return (
              <div key={o.id} className="card">
                <div style={{ fontWeight: 600 }}>
                  {o.decision?.kind} {o.epic}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: pn >= 0 ? 'var(--ok, #2a7)' : 'var(--bad, #c44)',
                  }}
                >
                  {pn.toFixed(2)} · {String(o.outcome?.exit_reason || '').slice(0, 48)}
                </div>
              </div>
            );
          })
        )}
      </div>

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
