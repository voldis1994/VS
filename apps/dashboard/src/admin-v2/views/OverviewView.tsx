import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { useCommandDesk } from '../context/CommandDeskContext';
import { apiFetch } from '../../hooks/useApi';

type Position = {
  client_name?: string;
  account_name?: string;
  symbol?: string;
  direction?: string;
  unrealized_pnl?: number;
};

type SystemEvent = {
  event_type?: string;
  message?: string;
  created_at?: string;
};

type MarketOpt = {
  epic?: string;
  symbol: string;
  display_name: string;
  lot_size: number;
  min_lot: number;
};

const MODES = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'] as const;

export function OverviewView() {
  const { status, clients, accounts, selectedAccountId, setSelectedAccountId, refresh } =
    useCommandDesk();
  const navigate = useNavigate();
  const [positions, setPositions] = useState<Position[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [markets, setMarkets] = useState<MarketOpt[]>([]);
  const [marketEpic, setMarketEpic] = useState('');
  const [lotSize, setLotSize] = useState('0.1');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const [pos, ev] = await Promise.all([
        apiFetch<Position[]>('/api/positions').catch(() => []),
        apiFetch<SystemEvent[]>('/api/system/events').catch(() => []),
      ]);
      setPositions(pos);
      setEvents(ev.slice(0, 8));
    };
    void load();
    const t = setInterval(() => void load(), 6000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!selectedAccountId) {
      setMarkets([]);
      return;
    }
    void apiFetch<MarketOpt[]>(`/api/trading/accounts/${selectedAccountId}/instruments`)
      .then((rows) => {
        setMarkets(rows);
        if (rows[0]) {
          setMarketEpic(rows[0].epic || rows[0].symbol);
          setLotSize(String(rows[0].lot_size || rows[0].min_lot || 0.1));
        }
      })
      .catch(() => setMarkets([]));
  }, [selectedAccountId]);

  const liveAccounts = accounts.filter((a) => a.environment === 'live').length;
  const mode = String(status?.mode || '—').toUpperCase();
  const runnerOn = Boolean(status?.live_enabled) && mode === 'LIVE';

  const deployRobot = () => {
    if (!selectedAccountId || !marketEpic) {
      setMsg('Izvēlies account + tirgu');
      return;
    }
    const lot = Number(lotSize);
    if (!Number.isFinite(lot) || lot <= 0) {
      setMsg('Lot > 0');
      return;
    }
    const m = markets.find((x) => (x.epic || x.symbol) === marketEpic);
    const q = new URLSearchParams({
      account_id: String(selectedAccountId),
      epic: marketEpic,
      lot: String(lot),
      name: m?.display_name || marketEpic,
    });
    navigate(`/robot?${q.toString()}`);
  };

  const applyMode = async (next: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: next }),
      });
      setMsg(`Mode → ${next}`);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Mode failed');
    } finally {
      setBusy(false);
    }
  };

  const armLive = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ live_trading_enabled: true, confirm_live: true }),
      });
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'LIVE' }),
      });
      setMsg('LIVE armed');
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Arm failed');
    } finally {
      setBusy(false);
    }
  };

  const parkRunner = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'PAPER' }),
      });
      setMsg('Parked → PAPER');
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Park failed');
    } finally {
      setBusy(false);
    }
  };

  const recentEvents = useMemo(() => events, [events]);

  return (
    <div>
      <PageHeader
        kicker="VS SYSTEM // OPERATOR"
        title="Overview"
        stats={[
          { label: 'Clients', value: clients.length },
          { label: 'Accounts', value: accounts.length },
          { label: 'Open', value: status?.open_positions ?? 0 },
          { label: 'Fills', value: status?.today_executions ?? 0 },
        ]}
        actions={
          <>
            <button className="cmd-btn cmd-btn--go" type="button" disabled={busy || runnerOn} onClick={() => void armLive()}>
              Arm LIVE
            </button>
            <button className="cmd-btn cmd-btn--stop" type="button" disabled={busy || !runnerOn} onClick={() => void parkRunner()}>
              Park
            </button>
          </>
        }
      />

      {msg && (
        <div className={`cmd-banner ${msg.includes('failed') || msg.includes('Failed') ? 'cmd-banner--err' : 'cmd-banner--ok'}`}>
          {msg}
        </div>
      )}

      <div className="cmd-grid cmd-grid--2">
        <section className="cmd-panel">
          <div className="cmd-section-title">Desk metrics</div>
          <div className="cmd-grid cmd-grid--3">
            <div className="cmd-metric">
              <div className="label">Mode</div>
              <div className="value">{mode}</div>
            </div>
            <div className="cmd-metric">
              <div className="label">Live gate</div>
              <div className={`value ${runnerOn ? 'pos' : ''}`}>{runnerOn ? 'ON' : 'OFF'}</div>
            </div>
            <div className="cmd-metric">
              <div className="label">Live accounts</div>
              <div className="value">{liveAccounts}</div>
            </div>
            <div className="cmd-metric">
              <div className="label">Market core</div>
              <div className="value">{String(status?.market_core || '—')}</div>
            </div>
            <div className="cmd-metric">
              <div className="label">Execution</div>
              <div className="value">{String(status?.execution || '—')}</div>
            </div>
            <div className="cmd-metric">
              <div className="label">Database</div>
              <div className="value">{String(status?.database || '—')}</div>
            </div>
          </div>

          <div className="cmd-section-title" style={{ marginTop: '1rem' }}>
            Operating mode
          </div>
          <div className="cmd-chip-row">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`cmd-chip ${mode === m ? 'live focus' : ''}`}
                disabled={busy}
                onClick={() => void applyMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </section>

        <section className="cmd-panel">
          <div className="cmd-section-title">Quick deploy</div>
          <div className="cmd-deploy-row">
            <select
              className="cmd-select"
              value={selectedAccountId ?? ''}
              onChange={(e) => setSelectedAccountId(Number(e.target.value))}
            >
              {accounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.client_name} · #{a.account_id}
                </option>
              ))}
            </select>
            <select
              className="cmd-select"
              value={marketEpic}
              onChange={(e) => {
                setMarketEpic(e.target.value);
                const m = markets.find((x) => (x.epic || x.symbol) === e.target.value);
                if (m) setLotSize(String(m.lot_size || m.min_lot || 0.1));
              }}
            >
              {markets.slice(0, 120).map((m) => (
                <option key={m.epic || m.symbol} value={m.epic || m.symbol}>
                  {m.display_name}
                </option>
              ))}
            </select>
            <input className="cmd-input" style={{ maxWidth: 90 }} value={lotSize} onChange={(e) => setLotSize(e.target.value)} />
            <button className="cmd-btn cmd-btn--primary" type="button" onClick={deployRobot}>
              Open robot board
            </button>
          </div>
        </section>

        <section className="cmd-panel">
          <div className="cmd-section-title">Open positions</div>
          <div className="cmd-table-wrap">
            <table className="cmd-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>UPL</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 && (
                  <tr>
                    <td colSpan={4} className="mono">
                      No open positions
                    </td>
                  </tr>
                )}
                {positions.slice(0, 12).map((p, i) => (
                  <tr key={i}>
                    <td>{p.client_name || p.account_name || '—'}</td>
                    <td className="mono">{p.symbol || '—'}</td>
                    <td>{p.direction || '—'}</td>
                    <td className={(p.unrealized_pnl || 0) >= 0 ? 'pos' : 'neg'}>
                      {p.unrealized_pnl?.toFixed(2) ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="cmd-panel">
          <div className="cmd-section-title">Recent events</div>
          <div className="mono" style={{ fontSize: '0.72rem', lineHeight: 1.6 }}>
            {recentEvents.length === 0 && <div className="cmd-empty">No events</div>}
            {recentEvents.map((e, i) => (
              <div key={i}>
                <span style={{ color: 'var(--cmd-muted)' }}>
                  {e.created_at ? new Date(e.created_at).toLocaleTimeString() : '—'}
                </span>{' '}
                · {e.event_type || 'event'} · {e.message || '—'}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
