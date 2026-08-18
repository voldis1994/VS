import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { StatusBadge } from '../components/StatusBadge';

export function FeedsPage() {
  const { data, error, loading } = useApi<Array<Record<string, unknown>>>('/api/feeds', 4000);

  if (loading) return <div className="empty-state">Loading senders...</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <h1 className="page-title">Senders / Feeds</h1>
      <p className="page-subtitle">
        Real data senders (Capital.com broker rows + FX reference + catalog). Not synthetic.
        Open <Link to="/orbit">Orbit Reader</Link> to watch simultaneous trusted reads.
      </p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Sender</th>
              <th>Kind</th>
              <th>Trust</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Reliability</th>
              <th>OK/Fail</th>
              <th>Last OK</th>
            </tr>
          </thead>
          <tbody>
            {(data || []).length === 0 && (
              <tr>
                <td colSpan={9} className="mono">
                  No senders yet — add Capital.com brokers (you can add several).
                </td>
              </tr>
            )}
            {(data || []).map((f) => (
              <tr key={String(f.sender_id || f.source_id)}>
                <td>{String(f.source_id)}</td>
                <td>{String(f.name)}</td>
                <td className="mono">{String(f.kind || '—')}</td>
                <td className="mono">{String(f.trust || '—')}</td>
                <td>
                  <StatusBadge status={String(f.status)} />
                </td>
                <td>{Number(f.latency_ms || 0).toFixed(0)}ms</td>
                <td>{(Number(f.reliability || 0) * 100).toFixed(0)}%</td>
                <td className="mono">
                  {String(f.reads_ok ?? 0)}/{String(f.reads_fail ?? 0)}
                </td>
                <td style={{ fontSize: 12 }}>
                  {f.last_event && String(f.last_event) !== new Date(0).toISOString()
                    ? new Date(String(f.last_event)).toLocaleTimeString()
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
