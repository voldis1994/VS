import { useSystemStatus } from '../hooks/useApi';
import { StatusBadge } from '../components/StatusBadge';
import { Logo } from '../components/Logo';

export function OverviewPage() {
  const { data, error, loading } = useSystemStatus();

  if (loading) return <div className="empty-state">SYNCING DESK STATUS...</div>;
  if (error) return <div className="error-state">{error}</div>;
  if (!data) return null;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 20 }}>
        <Logo size={56} />
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>Overview</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            Prop-style risk & execution control // Market Reader
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <MetricCard label="Operating Mode" value={data.mode} badge />
        <MetricCard label="Market Core" value={data.market_core} status={data.market_core} />
        <MetricCard label="Execution" value={data.execution} status={data.execution} />
        <MetricCard label="Database" value={data.database} status={data.database} />
      </div>
      <div className="grid grid-4">
        <MetricCard label="Active Feeds" value={String(data.feeds?.active ?? 0)} />
        <MetricCard label="Unhealthy Feeds" value={String(data.feeds?.unhealthy ?? 0)} />
        <MetricCard label="Open Positions" value={String(data.open_positions ?? 0)} />
        <MetricCard label="Today Executions" value={String(data.today_executions ?? 0)} />
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  status,
  badge,
}: {
  label: string;
  value: string;
  status?: string;
  badge?: boolean;
}) {
  return (
    <div className="card">
      <div className="section-title">{label}</div>
      <div className="metric-value">
        {badge ? <span className="badge badge-mode">{value}</span> : value}
      </div>
      {status && <StatusBadge status={status} />}
    </div>
  );
}
