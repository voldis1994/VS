import { useParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi';

export function EvidencePage() {
  const { instrumentId } = useParams();
  const { data, error, loading } = useApi<{
    instrument_id: number;
    setup_lifecycle: string;
    supporting: unknown[];
    contradicting: unknown[];
    evidence_strength: number;
    trade_intent: unknown;
  }>(`/api/market/evidence/${instrumentId || '1'}`, 3000);

  if (loading) return <div className="empty-state">Loading evidence...</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <h1 className="page-title">Live Evidence {instrumentId ? `#${instrumentId}` : ''}</h1>
      <div className="grid grid-2">
        <div className="card">
          <div className="section-title">Setup Lifecycle</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{data?.setup_lifecycle || 'NONE'}</div>
          <div style={{ marginTop: 12 }}>
            Strength: <strong>{data?.evidence_strength?.toFixed(2) ?? '0'}</strong>
          </div>
        </div>
        <div className="card">
          <div className="section-title">Trade Intent</div>
          {data?.trade_intent ? (
            <pre style={{ fontSize: 12, overflow: 'auto' }}>
              {JSON.stringify(data.trade_intent, null, 2)}
            </pre>
          ) : (
            <div className="empty-state">No active trade intent</div>
          )}
        </div>
        <div className="card">
          <div className="section-title">Supporting Evidence</div>
          {(data?.supporting?.length ?? 0) === 0 ? (
            <div className="empty-state">No supporting evidence yet</div>
          ) : (
            <ul>{data?.supporting?.map((e, i) => <li key={i}>{JSON.stringify(e)}</li>)}</ul>
          )}
        </div>
        <div className="card">
          <div className="section-title">Contradicting Evidence</div>
          {(data?.contradicting?.length ?? 0) === 0 ? (
            <div className="empty-state">No contradicting evidence</div>
          ) : (
            <ul>{data?.contradicting?.map((e, i) => <li key={i}>{JSON.stringify(e)}</li>)}</ul>
          )}
        </div>
      </div>
    </div>
  );
}
