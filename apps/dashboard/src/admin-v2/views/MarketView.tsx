import { PageHeader } from '../components/PageHeader';
import { useApi } from '../../hooks/useApi';

type Instrument = {
  instrument_id: number;
  symbol: string;
  display_name?: string;
  epic?: string;
  regime?: string;
  last_mid?: number;
};

export function MarketView() {
  const { data, error, loading } = useApi<Instrument[]>('/api/market/instruments', 3000);

  return (
    <div>
      <PageHeader kicker="VS SYSTEM // REGIMES" title="Market reader" stats={[{ label: 'Instruments', value: data?.length ?? 0 }]} />
      {loading && <div className="cmd-banner cmd-banner--busy">Loading…</div>}
      {error && <div className="cmd-banner cmd-banner--err">{error}</div>}
      <section className="cmd-panel">
        <div className="cmd-table-wrap">
          <table className="cmd-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Name</th>
                <th>Regime</th>
                <th>Mid</th>
              </tr>
            </thead>
            <tbody>
              {(data || []).slice(0, 80).map((r) => (
                <tr key={r.instrument_id}>
                  <td className="mono">{r.epic || r.symbol}</td>
                  <td>{r.display_name || r.symbol}</td>
                  <td>
                    <span className="cmd-chip live">{String(r.regime || 'UNKNOWN').toUpperCase()}</span>
                  </td>
                  <td className="mono">{r.last_mid != null ? Number(r.last_mid).toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
