import { PageHeader } from '../components/PageHeader';
import { useApi } from '../../hooks/useApi';

type Position = Record<string, unknown>;

export function PositionsView() {
  const { data, error, loading } = useApi<Position[]>('/api/positions', 3000);

  return (
    <div>
      <PageHeader kicker="VS SYSTEM // BOOK" title="Positions" stats={[{ label: 'Open', value: data?.length ?? 0 }]} />
      {loading && <div className="cmd-banner cmd-banner--busy">Loading…</div>}
      {error && <div className="cmd-banner cmd-banner--err">{error}</div>}
      <section className="cmd-panel">
        <div className="cmd-table-wrap">
          <table className="cmd-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Entry</th>
                <th>UPL</th>
              </tr>
            </thead>
            <tbody>
              {(data || []).length === 0 && (
                <tr>
                  <td colSpan={6} className="mono">
                    No open positions
                  </td>
                </tr>
              )}
              {(data || []).map((p, i) => (
                <tr key={i}>
                  <td>{String(p.client_name || p.account_name || '—')}</td>
                  <td className="mono">{String(p.symbol || '—')}</td>
                  <td>{String(p.direction || '—')}</td>
                  <td className="mono">{String(p.quantity ?? '—')}</td>
                  <td className="mono">{String(p.entry_price ?? '—')}</td>
                  <td className={Number(p.unrealized_pnl || 0) >= 0 ? 'pos' : 'neg'}>
                    {p.unrealized_pnl != null ? Number(p.unrealized_pnl).toFixed(2) : '—'}
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
