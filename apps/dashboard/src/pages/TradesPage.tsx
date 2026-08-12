import { useApi } from '../hooks/useApi';

export function TradesPage() {
  const { data, error, loading } = useApi<unknown[]>('/api/trades');

  if (loading) return <div className="empty-state">Loading trades...</div>;
  if (error) return <div className="error-state">{error}</div>;

  const trades = (data || []) as Array<Record<string, unknown>>;

  return (
    <div>
      <h1 className="page-title">Trades</h1>
      <div className="card">
        {trades.length === 0 ? (
          <div className="empty-state">No trades recorded</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th><th>Client</th><th>Instrument</th><th>Direction</th>
                <th>Entry</th><th>Exit</th><th>PnL</th><th>Regime</th><th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={String(t.id)}>
                  <td>{String(t.id)}</td>
                  <td>{String(t.client_name)}</td>
                  <td>{String(t.instrument_id)}</td>
                  <td>{String(t.direction)}</td>
                  <td>{String(t.entry_price)}</td>
                  <td>{String(t.exit_price ?? '—')}</td>
                  <td style={{ color: Number(t.pnl) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {String(t.pnl ?? '—')}
                  </td>
                  <td>{String(t.regime ?? '—')}</td>
                  <td>{t.closed_at ? new Date(String(t.closed_at)).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
