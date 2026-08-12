import { useState } from 'react';
import { useApi, apiFetch } from '../hooks/useApi';

export function SettingsPage() {
  const { data, refresh } = useApi<Record<string, unknown>>('/api/settings');
  const [confirmMode, setConfirmMode] = useState(false);
  const [newMode, setNewMode] = useState('');

  const handleModeChange = async () => {
    if (!confirmMode) {
      setConfirmMode(true);
      return;
    }
    await apiFetch('/api/system/mode', {
      method: 'POST',
      body: JSON.stringify({ mode: newMode }),
    });
    setConfirmMode(false);
    refresh();
  };

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Operating Mode</div>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
          Current: <strong>{String(data?.operating_mode ?? 'PAPER')}</strong>
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="input" style={{ maxWidth: 200 }} value={newMode || String(data?.operating_mode)}
            onChange={(e) => { setNewMode(e.target.value); setConfirmMode(false); }}>
            <option value="REPLAY">REPLAY</option>
            <option value="PAPER">PAPER</option>
            <option value="DEMO">DEMO</option>
            <option value="LIVE">LIVE</option>
          </select>
          <button className={`btn ${confirmMode ? 'btn-danger' : 'btn-primary'}`}
            onClick={handleModeChange}>
            {confirmMode ? 'Confirm Change' : 'Change Mode'}
          </button>
        </div>
        {newMode === 'LIVE' && (
          <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
            LIVE mode requires LIVE_TRADING_ENABLED=true in server configuration.
          </p>
        )}
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
