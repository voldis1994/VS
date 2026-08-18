import { useEffect, useState } from 'react';
import { useApi, apiFetch } from '../hooks/useApi';

interface Client {
  id: number;
  name: string;
  enabled: boolean;
}

interface BrokerRow {
  id: number;
  client_name: string;
  broker_name: string;
  environment: string;
  enabled: boolean;
}

export function BrokersPage() {
  const { data, error, loading, refresh } = useApi<BrokerRow[]>('/api/brokers');
  const { data: clients, refresh: refreshClients } = useApi<Client[]>('/api/clients');
  const [form, setForm] = useState({
    client_id: '',
    broker_name: 'capital_com',
    environment: 'demo',
    identifier: '',
    api_key: '',
    password: '',
  });
  const [testing, setTesting] = useState<number | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  useEffect(() => {
    if (!clients || clients.length === 0) return;
    if (!form.client_id) {
      setForm((prev) => ({ ...prev, client_id: String(clients[0].id) }));
    }
  }, [clients, form.client_id]);

  const ensureClient = async (): Promise<number> => {
    if (form.client_id) return parseInt(form.client_id, 10);
    if (clients && clients.length > 0) return clients[0].id;
    const created = await apiFetch<Client>('/api/clients', {
      method: 'POST',
      body: JSON.stringify({ name: form.identifier.trim() || 'Default Client' }),
    });
    refreshClients();
    setForm((prev) => ({ ...prev, client_id: String(created.id) }));
    return created.id;
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      if (!form.identifier.trim()) {
        throw new Error('Identifier (login email) is required');
      }
      if (form.broker_name === 'capital_com') {
        if (!form.api_key.trim() || !form.password.trim()) {
          throw new Error('Capital.com needs API Key and API Password from Settings → API');
        }
        if (form.api_key.includes('@')) {
          throw new Error('API Key looks like an email — put email in Identifier, API key in API Key');
        }
      }
      const clientId = await ensureClient();
      await apiFetch('/api/brokers', {
        method: 'POST',
        body: JSON.stringify({
          client_id: clientId,
          broker_name: form.broker_name,
          environment: form.environment,
          identifier: form.identifier.trim(),
          api_key: form.api_key.trim(),
          password: form.password.trim(),
        }),
      });
      setForm((prev) => ({ ...prev, api_key: '', password: '' }));
      setSaveOk(true);
      refresh();
      refreshClients();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    setTestMessage(null);
    setTestOk(null);
    try {
      const result = await apiFetch<{ success?: boolean; message?: string; error?: string }>(
        `/api/brokers/${id}/test`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      if (!result?.success) {
        setTestOk(false);
        setTestMessage(result?.error || 'Connection test failed');
        return;
      }
      setTestOk(true);
      setTestMessage(result.message || 'Connection test successful');
    } catch (e) {
      setTestOk(false);
      setTestMessage(e instanceof Error ? e.message : 'Connection test failed');
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async (b: BrokerRow) => {
    const ok = window.confirm(
      `DELETE broker #${b.id} (${b.broker_name} / ${b.environment})?\n\nRemoves credentials and linked trading account settings.`
    );
    if (!ok) return;
    try {
      await apiFetch(`/api/brokers/${b.id}?hard=true`, { method: 'DELETE' });
      setTestOk(true);
      setTestMessage(`Deleted broker connection #${b.id}`);
      refresh();
    } catch (e) {
      setTestOk(false);
      setTestMessage(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  if (loading) return <div className="empty-state">LOADING BROKERS...</div>;
  if (error) return <div className="error-state">{error}</div>;

  const brokers = data || [];
  const clientOptions = clients || [];

  return (
    <div>
      <h1 className="page-title">Brokers</h1>
      <p className="page-subtitle">
        Capital.com Live / Demo — execution venue. Public internet feeds (Yahoo, Aurum, Gold-API, Fawaz, Coinbase, Kraken, KuCoin, Binance.US, CoinGecko, Bitstamp) fuse into 10s OHLC automatically.
      </p>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Add Broker Connection</div>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Client</span>
            <select
              className="input"
              value={form.client_id}
              onChange={(e) => setForm({ ...form, client_id: e.target.value })}
            >
              {clientOptions.length === 0 && <option value="">Will create Default Client</option>}
              {clientOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (#{c.id})
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Broker</span>
            <select
              className="input"
              value={form.broker_name}
              onChange={(e) => setForm({ ...form, broker_name: e.target.value })}
            >
              <option value="capital_com">Capital.com</option>
              <option value="paper">Paper</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Environment</span>
            <select
              className="input"
              value={form.environment}
              onChange={(e) => setForm({ ...form, environment: e.target.value })}
            >
<option value="demo">Demo</option>
            <option value="live">Live (real money)</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Identifier (login email)</span>
            <input
              className="input"
              placeholder="you@email.com"
              value={form.identifier}
              onChange={(e) => setForm({ ...form, identifier: e.target.value })}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>API Key (not email)</span>
            <input
              className="input"
              type="password"
              placeholder="Capital.com API key"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              API Password (custom password from key creation — NOT 2FA code, NOT account password)
            </span>
            <input
              className="input"
              type="password"
              placeholder="API key custom password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="off"
            />
          </label>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Connection'}
        </button>
        {saveError && <p className="error-state" style={{ marginTop: 8 }}>{saveError}</p>}
        {saveOk && (
          <p style={{ fontSize: 13, color: 'var(--success)', marginTop: 8 }}>
            Saved. Use Test on the row below.
          </p>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          <strong>2FA:</strong> needed only when generating the API key on Capital.com website.
          Do not put the authenticator code in this form.
          Password field = the <strong>custom API password</strong> you chose when creating the key
          (Settings → API integrations), for <strong>Live</strong> or <strong>Demo</strong> separately.
        </p>
      </div>
      {testMessage && (
        <div
          className="card"
          style={{
            marginBottom: 16,
            borderColor: testOk ? 'var(--success)' : 'var(--danger)',
          }}
        >
          <div className="section-title">{testOk ? 'Test OK' : 'Test failed'}</div>
          <p style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: testOk ? 'var(--success)' : 'var(--danger)' }}>
            {testMessage}
          </p>
        </div>
      )}
      <div className="card">
        <div className="section-title">Connections</div>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Client</th>
              <th>Broker</th>
              <th>Env</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {brokers.map((b) => (
              <tr key={String(b.id)}>
                <td className="mono">#{String(b.id)}</td>
                <td>{String(b.client_name)}</td>
                <td className="mono">{String(b.broker_name)}</td>
                <td>
                  <span className={`badge ${b.environment === 'live' ? 'badge-unhealthy' : 'badge-mode'}`}>
                    {String(b.environment)}
                  </span>
                </td>
                <td>
                  <span className={`badge ${b.enabled ? 'badge-healthy' : 'badge-unhealthy'}`}>
                    {b.enabled ? 'ENABLED' : 'DISABLED'}
                  </span>
                </td>
                <td>
                  <div className="actions">
                    <button
                      className="btn"
                      onClick={() => handleTest(Number(b.id))}
                      disabled={testing === Number(b.id)}
                    >
                      {testing === Number(b.id) ? 'Testing...' : 'Test'}
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDelete(b)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {brokers.length === 0 && <div className="empty-state">NO BROKER CONNECTIONS</div>}
      </div>
    </div>
  );
}
