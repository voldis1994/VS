import { useState } from 'react';
import { useApi, apiFetch } from '../hooks/useApi';

export function BrokersPage() {
  const { data, error, loading, refresh } = useApi<unknown[]>('/api/brokers');
  const [form, setForm] = useState({
    client_id: '1', broker_name: 'capital_com', environment: 'demo',
    identifier: '', api_key: '', password: '',
  });
  const [testing, setTesting] = useState<number | null>(null);

  const handleSave = async () => {
    await apiFetch('/api/brokers', {
      method: 'POST',
      body: JSON.stringify({
        ...form,
        client_id: parseInt(form.client_id, 10),
      }),
    });
    setForm({ ...form, api_key: '', password: '' });
    refresh();
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      await apiFetch(`/api/brokers/${id}/test`, { method: 'POST' });
      alert('Connection test successful');
    } catch {
      alert('Connection test failed');
    } finally {
      setTesting(null);
    }
  };

  if (loading) return <div className="empty-state">Loading brokers...</div>;
  if (error) return <div className="error-state">{error}</div>;

  const brokers = (data || []) as Array<Record<string, unknown>>;

  return (
    <div>
      <h1 className="page-title">Broker Connections</h1>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Add Broker Connection</div>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <input className="input" placeholder="Client ID" value={form.client_id}
            onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
          <select className="input" value={form.broker_name}
            onChange={(e) => setForm({ ...form, broker_name: e.target.value })}>
            <option value="capital_com">Capital.com</option>
            <option value="paper">Paper</option>
          </select>
          <select className="input" value={form.environment}
            onChange={(e) => setForm({ ...form, environment: e.target.value })}>
            <option value="demo">Demo</option>
            <option value="live">Live</option>
          </select>
          <input className="input" placeholder="Identifier / Account" value={form.identifier}
            onChange={(e) => setForm({ ...form, identifier: e.target.value })} />
          <input className="input" type="password" placeholder="API Key" value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
          <input className="input" type="password" placeholder="Password" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleSave}>
          Save Connection
        </button>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          Secrets are encrypted server-side. After save, only masked values are shown.
        </p>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>ID</th><th>Client</th><th>Broker</th><th>Env</th><th>Status</th><th>Actions</th></tr>
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
                  <button className="btn" onClick={() => handleTest(Number(b.id))}
                    disabled={testing === Number(b.id)}>
                    Test
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
