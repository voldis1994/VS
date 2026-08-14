import { useApi } from '../hooks/useApi';

export function SystemPage() {
  const { data: status } = useApi<Record<string, unknown>>('/api/system/status', 3000);
  const { data: settings } = useApi<Record<string, unknown>>('/api/settings');

  return (
    <div>
      <h1 className="page-title">System</h1>
      <div className="grid grid-2">
        <div className="card">
          <div className="section-title">Process Health</div>
          <div className="grid grid-2" style={{ gap: 8 }}>
            {['market_core', 'execution', 'database', 'control_api', 'git_sha', 'entry_brain', 'sl'].map((k) => (
              <div key={k}>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{k}</span>
                <div style={{ fontWeight: 600 }}>{String(status?.[k] ?? '—')}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="section-title">Configuration</div>
          <pre style={{ fontSize: 12, overflow: 'auto' }}>
            {JSON.stringify(settings, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
