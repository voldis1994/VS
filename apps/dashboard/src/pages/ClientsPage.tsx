import { useState } from 'react';
import { useApi, apiFetch } from '../hooks/useApi';

interface Client {
  id: number;
  name: string;
  enabled: boolean;
  created_at: string;
}

export function ClientsPage() {
  const { data, error, loading, refresh } = useApi<Client[]>('/api/clients');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setMsg(null);
    try {
      await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to create account');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (client: Client) => {
    setMsg(null);
    await apiFetch(`/api/clients/${client.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: !client.enabled }),
    });
    refresh();
  };

  const handleDelete = async (client: Client) => {
    const ok = window.confirm(
      `DELETE account "${client.name}" (#${client.id})?\n\nThis permanently removes brokers, credentials, and trading settings.`
    );
    if (!ok) return;
    setMsg(null);
    try {
      await apiFetch(`/api/clients/${client.id}?hard=true`, { method: 'DELETE' });
      setMsg(`Deleted account #${client.id}`);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  if (loading) return <div className="empty-state">LOADING ACCOUNTS...</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <h1 className="page-title">Accounts</h1>
      <p className="page-subtitle">Client desks linked to broker connections</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Add Account</div>
        <div className="actions">
          <input
            className="input"
            placeholder="Account / client name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <button className="btn btn-primary" onClick={handleCreate} disabled={submitting}>
            Add Account
          </button>
        </div>
        {msg && <p style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{msg}</p>}
      </div>

      <div className="card">
        <div className="section-title">Account Roster</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(data || []).map((c) => (
                <tr key={c.id}>
                  <td className="mono">#{c.id}</td>
                  <td>{c.name}</td>
                  <td>
                    <span className={`badge ${c.enabled ? 'badge-healthy' : 'badge-unhealthy'}`}>
                      {c.enabled ? 'ENABLED' : 'DISABLED'}
                    </span>
                  </td>
                  <td className="mono">{new Date(c.created_at).toLocaleString()}</td>
                  <td>
                    <div className="actions">
                      <button className="btn" onClick={() => handleToggle(c)}>
                        {c.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className="btn btn-danger" onClick={() => handleDelete(c)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(!data || data.length === 0) && <div className="empty-state">NO ACCOUNTS YET</div>}
      </div>
    </div>
  );
}
