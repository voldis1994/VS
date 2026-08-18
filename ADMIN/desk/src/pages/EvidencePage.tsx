import { Link, useParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi';

type Evidence = {
  instrument_id: number;
  regime?: string;
  previous_regime?: string;
  setup_lifecycle?: string;
  evidence_strength?: number;
  catalog?: string[];
};

export function EvidencePage() {
  const { instrumentId } = useParams();
  const path = instrumentId
    ? `/api/market/evidence/${instrumentId}`
    : '/api/market/regimes';
  const { data } = useApi<Evidence & { names?: string[] }>(path, 4000);
  const catalog = data?.catalog || data?.names || [];

  return (
    <div>
      <h1 className="page-title">Evidence {instrumentId ? `#${instrumentId}` : ''}</h1>
      <p className="page-subtitle">Regime classifier · original 14 names</p>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">CURRENT</div>
        <p style={{ marginBottom: 12 }}>
          Regime: <strong>{data?.regime || 'UNKNOWN'}</strong>
          {data?.previous_regime ? ` · previous ${data.previous_regime}` : ''}
        </p>
        <div className="regime-catalog">
          {catalog.map((name) => (
            <span
              key={name}
              className={`regime-chip ${name === data?.regime ? 'on up' : ''}`}
            >
              {name}
            </span>
          ))}
        </div>
        <div className="actions" style={{ marginTop: 16 }}>
          <Link className="btn btn-primary" to="/market">
            Market Reader
          </Link>
          <Link className="btn" to="/orbit">
            Orbit Reader
          </Link>
        </div>
      </div>
    </div>
  );
}
