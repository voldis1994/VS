import { useApi } from '../hooks/useApi';

export function PositionsPage() {
  const { data, error, loading } = useApi<unknown[]>('/api/positions', 3000);

  if (loading) return <div className="empty-state">Loading positions...</div>;
  if (error) return <div className="error-state">{error}</div>;

  const positions = (data || []) as Array<Record<string, unknown>>;

  return (
    <div>
      <h1 className="page-title">Open Positions</h1>
      <div className="card">
        {positions.length === 0 ? (
          <div className="empty-state">No open positions</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th><th>Account</th><th>Instrument</th><th>Side</th>
                <th>Entry</th><th>Qty</th><th>MFE</th><th>MAE</th>
                <th>Peak Ret.</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={String(p.id)}>
                  <td>{String(p.client_name)}</td>
                  <td>{String(p.account_name)}</td>
                  <td>{String(p.instrument_id)}</td>
                  <td>{String(p.direction)}</td>
                  <td>{String(p.entry_price)}</td>
                  <td>{String(p.quantity)}</td>
                  <td>{String(p.mfe)}</td>
                  <td>{String(p.mae)}</td>
                  <td>{String(p.peak_retention)}</td>
                  <td>{String(p.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
