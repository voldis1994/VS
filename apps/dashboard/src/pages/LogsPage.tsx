import { useApi } from '../hooks/useApi';

export function LogsPage() {
  const { data, error, loading } = useApi<unknown[]>('/api/audit');

  if (loading) return <div className="empty-state">Loading audit logs...</div>;
  if (error) return <div className="error-state">{error}</div>;

  const logs = (data || []) as Array<Record<string, unknown>>;

  return (
    <div>
      <h1 className="page-title">Audit Logs</h1>
      <div className="card">
        {logs.length === 0 ? (
          <div className="empty-state">No audit log entries</div>
        ) : (
          <table>
            <thead>
              <tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>ID</th></tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={String(l.id)}>
                  <td style={{ fontSize: 12 }}>{new Date(String(l.created_at)).toLocaleString()}</td>
                  <td>{String(l.actor)}</td>
                  <td>{String(l.action)}</td>
                  <td>{String(l.entity_type)}</td>
                  <td>{String(l.entity_id ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
