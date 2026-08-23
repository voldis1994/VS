import { PageHeader } from '../components/PageHeader';
import { useApi } from '../../hooks/useApi';

export function FeedsView() {
  const { data, error, loading } = useApi<Array<Record<string, unknown>>>('/api/feeds', 4000);

  return (
    <div>
      <PageHeader kicker="VS SYSTEM // DATA" title="Feeds" stats={[{ label: 'Senders', value: data?.length ?? 0 }]} />
      {loading && <div className="cmd-banner cmd-banner--busy">Loading…</div>}
      {error && <div className="cmd-banner cmd-banner--err">{error}</div>}
      <section className="cmd-panel">
        <div className="cmd-table-wrap">
          <table className="cmd-table">
            <thead>
              <tr>
                <th>Sender</th>
                <th>Kind</th>
                <th>Trust</th>
                <th>Status</th>
                <th>Latency</th>
                <th>OK/Fail</th>
              </tr>
            </thead>
            <tbody>
              {(data || []).length === 0 && (
                <tr>
                  <td colSpan={6} className="mono">
                    No senders — add Capital.com brokers
                  </td>
                </tr>
              )}
              {(data || []).map((f) => (
                <tr key={String(f.sender_id || f.source_id)}>
                  <td>{String(f.name)}</td>
                  <td className="mono">{String(f.kind || '—')}</td>
                  <td className="mono">{String(f.trust || '—')}</td>
                  <td>
                    <span className="cmd-badge cmd-badge--ok">{String(f.status)}</span>
                  </td>
                  <td className="mono">{Number(f.latency_ms || 0).toFixed(0)}ms</td>
                  <td className="mono">
                    {String(f.reads_ok ?? 0)}/{String(f.reads_fail ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
