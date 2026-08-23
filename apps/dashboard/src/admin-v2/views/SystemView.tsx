import { PageHeader } from '../components/PageHeader';
import { useApi } from '../../hooks/useApi';

export function SystemView() {
  const { data: status } = useApi<Record<string, unknown>>('/api/system/status', 3000);
  const { data: settings } = useApi<Record<string, unknown>>('/api/settings');

  return (
    <div>
      <PageHeader
        kicker="VS SYSTEM // HEALTH"
        title="System"
        stats={[{ label: 'Mode', value: String(status?.mode || '—').toUpperCase() }]}
      />
      <div className="cmd-grid cmd-grid--2">
        <section className="cmd-panel">
          <div className="cmd-section-title">Process health</div>
          <div className="cmd-grid cmd-grid--2">
            {['market_core', 'execution', 'database', 'control_api'].map((k) => (
              <div key={k} className="cmd-metric">
                <div className="label">{k}</div>
                <div className="value">{String(status?.[k] ?? '—')}</div>
              </div>
            ))}
          </div>
        </section>
        <section className="cmd-panel">
          <div className="cmd-section-title">Configuration</div>
          <pre className="mono" style={{ margin: 0, fontSize: '0.68rem', overflow: 'auto', maxHeight: 360 }}>
            {JSON.stringify(settings, null, 2)}
          </pre>
        </section>
      </div>
    </div>
  );
}
