import { useApi } from '../hooks/useApi';
import { StatusBadge } from '../components/StatusBadge';

export function FeedsPage() {
  const { data, error, loading } = useApi<Array<Record<string, unknown>>>('/api/feeds', 3000);

  if (loading) return <div className="empty-state">Loading feeds...</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <h1 className="page-title">Feeds</h1>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Source</th><th>Name</th><th>Status</th><th>Latency</th>
              <th>Jitter</th><th>Stale Rate</th><th>Divergence</th>
              <th>Reliability</th><th>Predictive</th><th>Last Event</th>
            </tr>
          </thead>
          <tbody>
            {(data || []).map((f) => (
              <tr key={String(f.source_id)}>
                <td>{String(f.source_id)}</td>
                <td>{String(f.name)}</td>
                <td><StatusBadge status={String(f.status)} /></td>
                <td>{Number(f.latency_ms).toFixed(1)}ms</td>
                <td>{Number(f.jitter_ms).toFixed(1)}ms</td>
                <td>{(Number(f.stale_rate) * 100).toFixed(2)}%</td>
                <td>{Number(f.divergence).toFixed(6)}</td>
                <td>{(Number(f.reliability) * 100).toFixed(1)}%</td>
                <td>{(Number(f.predictive_score) * 100).toFixed(0)}%</td>
                <td style={{ fontSize: 12 }}>{new Date(String(f.last_event)).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
