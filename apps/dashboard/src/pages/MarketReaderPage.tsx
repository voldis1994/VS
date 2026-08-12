import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';

interface Instrument {
  instrument_id: number;
  symbol: string;
  regime: string;
  setup: string | null;
  evidence_state: string | null;
  direction_pressure: number;
  probability: number;
  expected_edge: number;
  data_quality: number;
  feed_consensus: number;
  entry_state: string;
  last_update: string;
}

export function MarketReaderPage() {
  const { data, error, loading } = useApi<Instrument[]>('/api/market/instruments', 3000);

  if (loading) return <div className="empty-state">Loading instruments...</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <h1 className="page-title">Market Reader</h1>
      <div className="card" style={{ overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Regime</th>
              <th>Setup</th>
              <th>Evidence</th>
              <th>Direction</th>
              <th>Probability</th>
              <th>Edge</th>
              <th>Data Quality</th>
              <th>Consensus</th>
              <th>Entry</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {(data || []).map((inst) => (
              <tr key={inst.instrument_id}>
                <td>
                  <Link to={`/evidence/${inst.instrument_id}`}>{inst.symbol}</Link>
                </td>
                <td><span className="badge badge-mode">{inst.regime}</span></td>
                <td>{inst.setup || '—'}</td>
                <td>{inst.evidence_state || '—'}</td>
                <td>{inst.direction_pressure.toFixed(2)}</td>
                <td>{(inst.probability * 100).toFixed(1)}%</td>
                <td>{inst.expected_edge.toFixed(6)}</td>
                <td>{(inst.data_quality * 100).toFixed(0)}%</td>
                <td>{(inst.feed_consensus * 100).toFixed(0)}%</td>
                <td>{inst.entry_state}</td>
                <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {new Date(inst.last_update).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!data || data.length === 0) && (
          <div className="empty-state">No instruments configured</div>
        )}
      </div>
    </div>
  );
}
