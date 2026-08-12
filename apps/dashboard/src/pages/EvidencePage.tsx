import { Link, useParams } from 'react-router-dom';

export function EvidencePage() {
  const { instrumentId } = useParams();

  return (
    <div>
      <h1 className="page-title">Evidence {instrumentId ? `#${instrumentId}` : ''}</h1>
      <p className="page-subtitle">Stub BUILDING lifecycle removed</p>
      <div className="card">
        <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
          Evidence API vairs neatgriež mūžīgo <strong>BUILDING</strong>. Live kotējumi — Orbit
          Reader; treidi — Trading.
        </p>
        <div className="actions">
          <Link className="btn btn-primary" to="/orbit">
            Orbit Reader
          </Link>
          <Link className="btn" to="/trading">
            Trading
          </Link>
        </div>
      </div>
    </div>
  );
}
