import { useState } from 'react';
import { useApi, apiFetch } from '../hooks/useApi';

export function SettingsPage() {
  const { data, refresh } = useApi<Record<string, unknown>>('/api/settings');
  const [confirmMode, setConfirmMode] = useState(false);
  const [newMode, setNewMode] = useState('');
  const [modeError, setModeError] = useState<string | null>(null);
  const [confirmLiveGate, setConfirmLiveGate] = useState(false);
  const [gateMsg, setGateMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleModeChange = async () => {
    setModeError(null);
    if (!confirmMode) {
      setConfirmMode(true);
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: newMode || data?.operating_mode }),
      });
      setConfirmMode(false);
      refresh();
    } catch (e) {
      setModeError(e instanceof Error ? e.message : 'Mode change failed');
      setConfirmMode(false);
    } finally {
      setBusy(false);
    }
  };

  const toggleLiveGate = async () => {
    const currentlyOn = Boolean(data?.live_trading_enabled);
    if (!currentlyOn && !confirmLiveGate) {
      setConfirmLiveGate(true);
      return;
    }
    setGateMsg(null);
    setBusy(true);
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          live_trading_enabled: !currentlyOn,
          confirm_live: true,
        }),
      });
      setConfirmLiveGate(false);
      setGateMsg(!currentlyOn ? 'LIVE trading gate ENABLED' : 'LIVE trading gate disabled');
      refresh();
    } catch (e) {
      setGateMsg(e instanceof Error ? e.message : 'Failed');
      setConfirmLiveGate(false);
    } finally {
      setBusy(false);
    }
  };

  /** One flow: unlock LIVE gate then switch operating mode to LIVE. */
  const enableLiveNow = async () => {
    setModeError(null);
    setGateMsg(null);
    setBusy(true);
    try {
      if (!data?.live_trading_enabled) {
        await apiFetch('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ live_trading_enabled: true, confirm_live: true }),
        });
      }
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'LIVE' }),
      });
      setNewMode('LIVE');
      setConfirmLiveGate(false);
      setConfirmMode(false);
      setGateMsg('LIVE gate ON + operating mode LIVE');
      refresh();
    } catch (e) {
      setModeError(e instanceof Error ? e.message : 'Failed to enable LIVE');
    } finally {
      setBusy(false);
    }
  };

  const liveOn = Boolean(data?.live_trading_enabled);

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Desk mode · LIVE gate · system params</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">LIVE trading gate</div>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
          Step 1 before real Capital.com money. Then Brokers = Live, Trading = Auto-trade ON.
        </p>
        <p style={{ marginBottom: 12 }}>
          Status:{' '}
          <span className={`badge ${liveOn ? 'badge-unhealthy' : 'badge-healthy'}`}>
            {liveOn ? 'LIVE ENABLED' : 'LIVE LOCKED'}
          </span>
        </p>
        <div className="actions">
          <button
            className={`btn ${confirmLiveGate || liveOn ? 'btn-danger' : 'btn-primary'}`}
            onClick={toggleLiveGate}
            disabled={busy}
          >
            {liveOn
              ? 'Disable LIVE gate'
              : confirmLiveGate
                ? 'Confirm: enable LIVE gate'
                : 'Enable LIVE trading'}
          </button>
          <button className="btn btn-primary" onClick={enableLiveNow} disabled={busy}>
            Unlock + switch to LIVE
          </button>
        </div>
        {gateMsg && <p style={{ marginTop: 8, fontSize: 13, color: 'var(--accent)' }}>{gateMsg}</p>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Operating Mode</div>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
          Current: <strong>{String(data?.operating_mode ?? 'PAPER')}</strong>
        </p>
        <div className="actions">
          <select
            className="input"
            style={{ maxWidth: 200 }}
            value={newMode || String(data?.operating_mode || 'PAPER')}
            onChange={(e) => {
              setNewMode(e.target.value);
              setConfirmMode(false);
              setModeError(null);
            }}
          >
            <option value="REPLAY">REPLAY</option>
            <option value="PAPER">PAPER</option>
            <option value="DEMO">DEMO</option>
            <option value="LIVE">LIVE</option>
          </select>
          <button
            className={`btn ${confirmMode ? 'btn-danger' : 'btn-primary'}`}
            onClick={handleModeChange}
            disabled={busy}
          >
            {confirmMode ? 'Confirm Change' : 'Change Mode'}
          </button>
        </div>
        {(newMode === 'LIVE' || data?.operating_mode === 'LIVE') && (
          <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
            LIVE sends real orders. Brokers → Capital.com Live, then Trading → Auto-trade ON.
          </p>
        )}
        {modeError && <p className="error-state" style={{ marginTop: 8 }}>{modeError}</p>}
      </div>

      <div className="card">
        <div className="section-title">System Parameters</div>
        <div className="grid grid-2" style={{ gap: 8 }}>
          <div>Primary Horizon: <strong>{String(data?.primary_horizon_ms)}ms</strong></div>
          <div>Entry TTL: <strong>{String(data?.entry_ttl_ms)}ms</strong></div>
          <div>Log Level: <strong>{String(data?.log_level)}</strong></div>
          <div>Live Enabled: <strong>{String(data?.live_trading_enabled)}</strong></div>
        </div>
      </div>
    </div>
  );
}
