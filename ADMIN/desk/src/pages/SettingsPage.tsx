import { useState } from 'react';
import { useApi, apiFetch } from '../hooks/useApi';

export function SettingsPage() {
  const { data, refresh } = useApi<Record<string, unknown>>('/api/settings');
  const [newMode, setNewMode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const goLive = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ live_trading_enabled: true, operating_mode: 'LIVE' }),
      });
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'LIVE' }),
      });
      setNewMode('LIVE');
      setMsg('LIVE ON — no gates');
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const changeMode = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const mode = newMode || String(data?.operating_mode || 'LIVE');
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      setMsg(`Mode → ${mode}`);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Mode change failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">No confirm gates · operator accepts risk</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">LIVE</div>
        <p style={{ marginBottom: 12 }}>
          Status:{' '}
          <span className="badge badge-unhealthy">
            {data?.live_trading_enabled === false ? 'OFF' : 'ON'} ·{' '}
            {String(data?.operating_mode ?? 'LIVE')}
          </span>
        </p>
        <div className="actions">
          <button className="btn btn-primary" onClick={goLive} disabled={busy}>
            Switch to LIVE now
          </button>
        </div>
        {msg && <p style={{ marginTop: 8, color: 'var(--accent)' }}>{msg}</p>}
        {err && <p className="error-state" style={{ marginTop: 8 }}>{err}</p>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Operating Mode</div>
        <div className="actions">
          <select
            className="input"
            style={{ maxWidth: 200 }}
            value={newMode || String(data?.operating_mode || 'LIVE')}
            onChange={(e) => setNewMode(e.target.value)}
          >
            <option value="REPLAY">REPLAY</option>
            <option value="PAPER">PAPER</option>
            <option value="DEMO">DEMO</option>
            <option value="LIVE">LIVE</option>
          </select>
          <button className="btn btn-primary" onClick={changeMode} disabled={busy}>
            Apply mode
          </button>
        </div>
      </div>

      <div className="card">
        <div className="section-title">System Parameters</div>
        <div className="grid grid-2" style={{ gap: 8 }}>
          <div>Primary Horizon: <strong>{String(data?.primary_horizon_ms)}ms</strong></div>
          <div>Entry TTL: <strong>{String(data?.entry_ttl_ms)}ms</strong></div>
          <div>Log Level: <strong>{String(data?.log_level)}</strong></div>
          <div>Live Enabled: <strong>{String(data?.live_trading_enabled !== false)}</strong></div>
        </div>
      </div>
    </div>
  );
}
