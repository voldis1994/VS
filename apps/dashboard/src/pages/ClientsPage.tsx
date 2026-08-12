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

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (client: Client) => {
    await apiFetch(`/api/clients/${client.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: !client.enabled }),
    });
    refresh();
  };

  if (loading) return <div className="empty-state">Loading clients...</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <h1 className="page-title">Clients</h1>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Add Client</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" placeholder="Client name" value={name}
            onChange={(e) => setName(e.target.value)} style={{ maxWidth: 300 }} />
          <button className="btn btn-primary" onClick={handleCreate} disabled={submitting}>
            Add Client
          </button>
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>ID</th><th>Name</th><th>Status</th><th>Created</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {(data || []).map((c) => (
              <tr key={c.id}>
                <td>{c.id}</td>
                <td>{c.name}</td>
                <td>
                  <span className={`badge ${c.enabled ? 'badge-healthy' : 'badge-unhealthy'}`}>
                    {c.enabled ? 'ENABLED' : 'DISABLED'}
                  </span>
                </td>
                <td>{new Date(c.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="btn" onClick={() => handleToggle(c)}>
                    {c.enabled ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!data || data.length === 0) && <div className="empty-state">No clients yet</div>}
      </div>
    </div>
  );
}
