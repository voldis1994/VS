import { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';

type ExpectancyBucket = {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  sum_pnl_pts: number;
  avg_pnl_pts: number;
  expectancy_pts: number;
  avg_win_pts: number;
  avg_loss_pts: number;
  profit_factor: number | null;
  avg_mfe: number;
  avg_mae: number;
  avg_hold_ms: number;
};

type ExpectancyReport = {
  window: string;
  since: string | null;
  total: ExpectancyBucket;
  by_regime: ExpectancyBucket[];
  by_setup: ExpectancyBucket[];
  by_exit_reason: ExpectancyBucket[];
  by_epic: ExpectancyBucket[];
  sample_size: number;
};

function fmt(n: unknown, digits = 2): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function fmtPct(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

function fmtPf(b: { profit_factor: number | null; wins: number; losses: number }): string {
  if (b.profit_factor != null && Number.isFinite(b.profit_factor)) return fmt(b.profit_factor);
  if (b.wins > 0 && b.losses === 0) return '∞';
  return '—';
}

function fmtHold(ms: unknown): string {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v < 60_000) return `${Math.round(v / 1000)}s`;
  return `${(v / 60_000).toFixed(1)}m`;
}

function BucketTable({ title, rows }: { title: string; rows: ExpectancyBucket[] }) {
  if (!rows.length) return null;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h2 className="section-title" style={{ marginBottom: 8 }}>{title}</h2>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>N</th>
            <th>Win%</th>
            <th>Expectancy</th>
            <th>Sum pts</th>
            <th>Avg W</th>
            <th>Avg L</th>
            <th>PF</th>
            <th>MFE</th>
            <th>MAE</th>
            <th>Hold</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key}>
              <td className="mono">{b.key}</td>
              <td>{b.trades}</td>
              <td>{fmtPct(b.win_rate)}</td>
              <td style={{ color: b.expectancy_pts >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {fmt(b.expectancy_pts)}
              </td>
              <td style={{ color: b.sum_pnl_pts >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {fmt(b.sum_pnl_pts)}
              </td>
              <td>{fmt(b.avg_win_pts)}</td>
              <td>{fmt(b.avg_loss_pts)}</td>
              <td>{fmtPf(b)}</td>
              <td>{fmt(b.avg_mfe)}</td>
              <td>{fmt(b.avg_mae)}</td>
              <td>{fmtHold(b.avg_hold_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TradesPage() {
  const [window, setWindow] = useState('30d');
  const tradesApi = useApi<unknown[]>(`/api/trades?limit=100`);
  const expApi = useApi<ExpectancyReport>(`/api/trades/expectancy?window=${window}`);

  const trades = (tradesApi.data || []) as Array<Record<string, unknown>>;
  const exp = expApi.data;

  const totalColor = useMemo(() => {
    if (!exp) return 'var(--text-secondary)';
    return exp.total.expectancy_pts >= 0 ? 'var(--success)' : 'var(--danger)';
  }, [exp]);

  if (tradesApi.loading && expApi.loading) {
    return <div className="empty-state">Loading trades...</div>;
  }
  if (tradesApi.error) return <div className="error-state">{tradesApi.error}</div>;

  return (
    <div>
      <h1 className="page-title">Trades · Expectancy</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 12, maxWidth: 720 }}>
        Closed-trade ledger for the Capital desk brain. Lot size stays operator-chosen —
        no daily loss / % equity entry blocks. Measure edge here; turn regimes OFF only when
        the numbers say so.
      </p>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="label">Window</span>
          {['24h', '7d', '30d', '90d', 'all'].map((w) => (
            <button
              key={w}
              type="button"
              className={window === w ? 'btn btn-primary' : 'btn'}
              onClick={() => setWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
        {expApi.error && <div className="error-state" style={{ marginTop: 8 }}>{expApi.error}</div>}
        {exp && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: 12,
              marginTop: 14,
            }}
          >
            <div>
              <div className="label">Sample</div>
              <div className="mono" style={{ fontSize: 20 }}>{exp.sample_size}</div>
            </div>
            <div>
              <div className="label">Expectancy (pts)</div>
              <div className="mono" style={{ fontSize: 20, color: totalColor }}>
                {fmt(exp.total.expectancy_pts)}
              </div>
            </div>
            <div>
              <div className="label">Win rate</div>
              <div className="mono" style={{ fontSize: 20 }}>{fmtPct(exp.total.win_rate)}</div>
            </div>
            <div>
              <div className="label">Sum pts</div>
              <div className="mono" style={{ fontSize: 20, color: totalColor }}>
                {fmt(exp.total.sum_pnl_pts)}
              </div>
            </div>
            <div>
              <div className="label">Avg W / L</div>
              <div className="mono" style={{ fontSize: 16 }}>
                {fmt(exp.total.avg_win_pts)} / {fmt(exp.total.avg_loss_pts)}
              </div>
            </div>
            <div>
              <div className="label">Profit factor</div>
              <div className="mono" style={{ fontSize: 20 }}>{fmtPf(exp.total)}</div>
            </div>
          </div>
        )}
      </div>

      {exp && (
        <>
          <BucketTable title="By regime" rows={exp.by_regime} />
          <BucketTable title="By setup" rows={exp.by_setup} />
          <BucketTable title="By exit reason" rows={exp.by_exit_reason} />
          <BucketTable title="By epic" rows={exp.by_epic} />
        </>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2 className="section-title" style={{ marginBottom: 8 }}>Closed trades</h2>
        {trades.length === 0 ? (
          <div className="empty-state">No closed trades recorded yet — run the desk and closes will land here.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Client</th>
                <th>Epic</th>
                <th>Side</th>
                <th>Setup</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Pts</th>
                <th>PnL</th>
                <th>MFE/MAE</th>
                <th>Regime</th>
                <th>Exit</th>
                <th>Src</th>
                <th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const pts = t.pnl_pts != null ? Number(t.pnl_pts) : Number(t.pnl);
                return (
                  <tr key={String(t.id)}>
                    <td>{String(t.id)}</td>
                    <td>{String(t.client_name ?? '—')}</td>
                    <td className="mono">{String(t.epic ?? t.instrument_id ?? '—')}</td>
                    <td>{String(t.direction)}</td>
                    <td>{String(t.setup_type ?? '—')}</td>
                    <td className="mono">{fmt(t.entry_price, 2)}</td>
                    <td className="mono">{t.exit_price != null ? fmt(t.exit_price, 2) : '—'}</td>
                    <td style={{ color: pts >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                      {Number.isFinite(pts) ? fmt(pts) : '—'}
                    </td>
                    <td style={{ color: Number(t.pnl) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                      {t.pnl != null ? fmt(t.pnl) : '—'}
                    </td>
                    <td className="mono">
                      {fmt(t.mfe)}/{fmt(t.mae)}
                    </td>
                    <td>{String(t.regime ?? '—')}</td>
                    <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={String(t.exit_reason ?? '')}>
                      {String(t.exit_reason ?? '—')}
                    </td>
                    <td>{String(t.source ?? '—')}</td>
                    <td>{t.closed_at ? new Date(String(t.closed_at)).toLocaleString() : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
