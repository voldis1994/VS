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
          api_key: form.api_key,
          password: form.password,
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
    try {
      const result = await apiFetch<{ success?: boolean; message?: string; error?: string }>(
        `/api/brokers/${id}/test`,
        { method: 'POST' }
      );
      if (result && result.success === false) {
        throw new Error(result.error || 'Connection test failed');
      }
      alert(result.message || 'Connection test successful');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Connection test failed');
    } finally {
      setTesting(null);
    }
  };

  if (loading) return <div className="empty-state">Loading brokers...</div>;
  if (error) return <div className="error-state">{error}</div>;

  const brokers = data || [];
  const clientOptions = clients || [];

  return (
    <div>
      <h1 className="page-title">Broker Connections</h1>
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
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>API Password</span>
            <input
              className="input"
              type="password"
              placeholder="Capital.com API password"
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
            Saved. Use Test on the row below. Prefer Demo until credentials verify.
          </p>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          Capital.com → Settings → API: create key for <strong>Demo</strong> or <strong>Live</strong> separately.
          Identifier = account email. Do not put email into API Key.
        </p>
      </div>
      <div className="card">
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
                <td>{String(b.id)}</td>
                <td>{String(b.client_name)}</td>
                <td>{String(b.broker_name)}</td>
                <td>{String(b.environment)}</td>
                <td>
                  <span className={`badge ${b.enabled ? 'badge-healthy' : 'badge-unhealthy'}`}>
                    {b.enabled ? 'ENABLED' : 'DISABLED'}
                  </span>
                </td>
                <td>
                  <button
                    className="btn"
                    onClick={() => handleTest(Number(b.id))}
                    disabled={testing === Number(b.id)}
                  >
                    {testing === Number(b.id) ? 'Testing...' : 'Test'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {brokers.length === 0 && <div className="empty-state">No broker connections</div>}
      </div>
    </div>
  );
}
