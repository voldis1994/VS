import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';

const REGIME_NAMES = [
  'RANGE',
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'COMPRESSION',
  'EXPANSION',
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
  'REVERSAL_CANDIDATE',
] as const;

const TRADE_TYPES = ['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP'] as const;

interface Instrument {
  instrument_id: number;
  symbol: string;
  display_name?: string;
  epic?: string;
  regime: string;
  previous_regime?: string;
  setup: string | null;
  evidence_state: string | null;
  direction_pressure: number;
  probability: number;
  expected_edge: number;
  data_quality: number;
  feed_consensus: number;
  entry_state: string;
  last_update: string;
  last_mid?: number | null;
  confidence?: number;
}

function regimeClass(name: string): string {
  const n = name.toUpperCase();
  if (n.includes('UP') || n === 'EXPANSION') return 'up';
  if (n.includes('DOWN') || n === 'COMPRESSION') return 'down';
  if (n === 'RANGE') return 'flat';
  return 'scalp';
}

export function MarketReaderPage() {
  const { data, error, loading } = useApi<Instrument[]>('/api/market/instruments', 3000);
  const live = data || [];
  const active = new Set(live.map((i) => String(i.regime || '').toUpperCase()));

  return (
    <div>
      <h1 className="page-title">Market Reader</h1>
      <p className="page-subtitle">
        Visi 14 režīmi ar oriģinālajiem nosaukumiem · LIVE klasifikācija no 10s OHLC
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">REGIMES — ORIGINAL NAMES</div>
        <div className="regime-catalog">
          {REGIME_NAMES.map((name) => (
            <span
              key={name}
              className={`regime-chip ${regimeClass(name)} ${active.has(name) ? 'on' : ''}`}
            >
              {name}
            </span>
          ))}
        </div>
        <div className="section-title" style={{ marginTop: 14 }}>
          TRADE TYPES
        </div>
        <div className="regime-catalog">
          {TRADE_TYPES.map((name) => (
            <span key={name} className="regime-chip scalp">
              {name}
            </span>
          ))}
        </div>
      </div>

      {error && <div className="error-state">{error}</div>}
      {loading && live.length === 0 && <div className="empty-state">Loading instruments…</div>}

      <div className="card" style={{ overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Regime</th>
              <th>Previous</th>
              <th>Setup</th>
              <th>Evidence</th>
              <th>Confidence</th>
              <th>Mid</th>
              <th>Entry</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {live.map((inst) => (
              <tr key={inst.instrument_id}>
                <td>
                  <Link to={`/evidence/${inst.instrument_id}`}>
                    {inst.display_name || inst.symbol}
                  </Link>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {inst.epic || inst.symbol}
                  </div>
                </td>
                <td>
                  <span className={`regime-chip ${regimeClass(inst.regime)} on`}>{inst.regime}</span>
                </td>
                <td>{inst.previous_regime || '—'}</td>
                <td>{inst.setup || '—'}</td>
                <td>{inst.evidence_state || '—'}</td>
                <td>{((inst.confidence ?? inst.probability) * 100).toFixed(0)}%</td>
                <td>{inst.last_mid != null ? inst.last_mid.toFixed(2) : '—'}</td>
                <td>{inst.entry_state}</td>
                <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {inst.last_update ? new Date(inst.last_update).toLocaleTimeString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {live.length === 0 && (
          <div className="empty-state">
            Nav live instrumentu. Palaid robotu vai Client Panel START — režīmi parādīsies no 10s
            svecēm. Katalogs augšā paliek redzams vienmēr.
          </div>
        )}
      </div>
    </div>
  );
}
