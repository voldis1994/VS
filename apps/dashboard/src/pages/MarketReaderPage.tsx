import { Link } from 'react-router-dom';

export function MarketReaderPage() {
  return (
    <div>
      <h1 className="page-title">Markets</h1>
      <p className="page-subtitle">Fake BUILDING / NO_TRADE grid removed</p>
      <div className="card">
        <p style={{ marginBottom: 12, color: 'var(--text-secondary)' }}>
          Vecais regime/evidence stub vienmēr rādīja <strong>BUILDING</strong> un nekad
          neprogresēja. Tas ir noņemts.
        </p>
        <div className="actions">
          <Link className="btn btn-primary" to="/orbit">
            Open Orbit Reader (real quotes)
          </Link>
          <Link className="btn" to="/trading">
            Open Trading
          </Link>
        </div>
      </div>
    </div>
  );
}
