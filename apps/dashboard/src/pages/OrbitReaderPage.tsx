import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../hooks/useApi';

type Sender = {
  sender_id: string;
  name: string;
  kind: string;
  trust: string;
  status: string;
  environment?: string;
  latency_ms: number | null;
  last_error: string | null;
  reads_ok: number;
  reads_fail: number;
};

type SenderRead = {
  sender_id: string;
  name: string;
  kind: string;
  epic: string;
  ok: boolean;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  market_status: string | null;
  source_time: string | null;
  latency_ms: number;
  detail?: string;
};

type Consensus = {
  epic: string;
  contributing: number;
  mid_avg: number | null;
  mid_span: number | null;
  agreement: string;
};

type Scan = {
  scanned_at: string;
  epics: string[];
  senders: Sender[];
  reads: SenderRead[];
  consensus: Consensus[];
  note: string;
};

type EpicOpt = { epic: string; display_name: string; category: string };

function fmt(n: number | null | undefined, digits = 5) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function OrbitReaderPage() {
  const [epics, setEpics] = useState<string[]>([]);
  const [options, setOptions] = useState<EpicOpt[]>([]);
  const [custom, setCustom] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [spinDeg, setSpinDeg] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSpinDeg((d) => (d + 0.35) % 360), 32);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void apiFetch<EpicOpt[]>('/api/robot-reader/epics?limit=24')
      .then((rows) => {
        setOptions(rows);
        if (rows.length && epics.length === 0) {
          setEpics(rows.slice(0, 3).map((r) => r.epic));
        }
      })
      .catch(() => undefined);
  }, []);

  const tick = useCallback(async () => {
    if (!running) return;
    setBusy(true);
    setError(null);
    try {
      const q = epics.length ? `?epics=${encodeURIComponent(epics.join(','))}` : '';
      const res = await apiFetch<Scan>(`/api/robot-reader/scan${q}`);
      setScan(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Orbit scan failed');
    } finally {
      setBusy(false);
    }
  }, [epics, running]);

  useEffect(() => {
    void tick();
    if (!running) return;
    const id = setInterval(() => void tick(), 4500);
    return () => clearInterval(id);
  }, [tick, running]);

  const senders = scan?.senders || [];
  const liveCount = senders.filter((s) => s.status === 'LIVE').length;
  const capitalCount = senders.filter((s) => s.kind === 'capital_com').length;

  const nodes = useMemo(() => {
    const list = senders.length ? senders : [{ sender_id: 'idle', name: 'Waiting', kind: 'idle', trust: '', status: 'IDLE', latency_ms: null, last_error: null, reads_ok: 0, reads_fail: 0 }];
    return list.map((s, i) => {
      const angle = (360 / list.length) * i + spinDeg;
      const rad = (angle * Math.PI) / 180;
      const r = 152;
      return {
        ...s,
        x: Math.cos(rad) * r,
        y: Math.sin(rad) * r,
      };
    });
  }, [senders, spinDeg]);

  const focusConsensus = scan?.consensus?.[0];
  const focusReads = (scan?.reads || []).filter((r) => r.epic === (scan?.epics?.[0] || r.epic));

  const addCustom = () => {
    const e = custom.trim();
    if (!e) return;
    setEpics((prev) => (prev.includes(e) ? prev : [...prev, e].slice(0, 6)));
    setCustom('');
  };

  return (
    <div className="orbit-page">
      <div className="orbit-hero">
        <div>
          <div className="orbit-kicker">MULTI-SENDER · TRUSTED ONLY</div>
          <h1 className="page-title">ORBIT READER</h1>
          <p className="page-subtitle">
            Robots lasa reālus kotējumus no vairākiem sūtītājiem vienlaikus — Capital.com (katrs brokeris =
            sūtītājs), ECB FX reference, kataloga pulse. Nekādu random cenu.
          </p>
        </div>
        <div className="orbit-hero-stats">
          <div className="orbit-stat">
            <span>Capital senders</span>
            <strong>{capitalCount}</strong>
          </div>
          <div className="orbit-stat">
            <span>Live now</span>
            <strong className="pos">{liveCount}</strong>
          </div>
          <div className="orbit-stat">
            <span>Scan</span>
            <strong>{busy ? 'READING' : running ? 'ORBITING' : 'PAUSED'}</strong>
          </div>
        </div>
      </div>

      {error && <div className="error-state" style={{ marginBottom: 12 }}>{error}</div>}
      {scan?.note && <div className="orbit-note">{scan.note}</div>}

      <div className="orbit-controls card">
        <div className="section-title">WATCHLIST (max 6)</div>
        <div className="orbit-chips">
          {epics.map((e) => (
            <button
              key={e}
              type="button"
              className="orbit-chip on"
              onClick={() => setEpics((prev) => prev.filter((x) => x !== e))}
              title="Remove"
            >
              {e} ×
            </button>
          ))}
        </div>
        <div className="orbit-chips" style={{ marginTop: 8 }}>
          {options.slice(0, 16).map((o) => (
            <button
              key={o.epic}
              type="button"
              className={`orbit-chip ${epics.includes(o.epic) ? 'on' : ''}`}
              onClick={() =>
                setEpics((prev) =>
                  prev.includes(o.epic)
                    ? prev.filter((x) => x !== o.epic)
                    : [...prev, o.epic].slice(0, 6),
                )
              }
            >
              {o.display_name}
            </button>
          ))}
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <input
            className="input"
            style={{ maxWidth: 280 }}
            placeholder="Custom epic (e.g. EURUSD)"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
          />
          <button className="btn" type="button" onClick={addCustom}>
            Add epic
          </button>
          <button className="btn btn-primary" type="button" onClick={() => void tick()} disabled={busy}>
            Scan now
          </button>
          <button className="btn" type="button" onClick={() => setRunning((v) => !v)}>
            {running ? 'Pause orbit' : 'Resume orbit'}
          </button>
        </div>
        {options.length === 0 && (
          <div className="hint-line" style={{ marginTop: 10 }}>
            Nav kataloga — Brokers → Test, tad Trading → Pull ALL Capital.com markets. Vairāki broker
            savienojumi = vairāki sūtītāji.
          </div>
        )}
      </div>

      <div className="orbit-stage">
        <div className="orbit-ring-wrap">
          <div className="orbit-ring" style={{ transform: `rotate(${spinDeg}deg)` }} />
          <div className="orbit-ring orbit-ring-2" style={{ transform: `rotate(${-spinDeg * 1.4}deg)` }} />
          <div className="orbit-core">
            <div className="orbit-core-label">CONSENSUS</div>
            <div className="orbit-core-epic">{scan?.epics?.[0] || '—'}</div>
            <div className="orbit-core-mid">
              {focusConsensus?.mid_avg != null ? fmt(focusConsensus.mid_avg) : '· · ·'}
            </div>
            <div className={`orbit-agree ${focusConsensus?.agreement?.toLowerCase() || ''}`}>
              {focusConsensus?.agreement || 'WAITING'} · {focusConsensus?.contributing ?? 0} Capital
            </div>
          </div>
          {nodes.map((n) => (
            <div
              key={n.sender_id}
              className={`orbit-node status-${(n.status || 'IDLE').toLowerCase()}`}
              style={{ transform: `translate(${n.x}px, ${n.y}px)` }}
              title={n.last_error || n.name}
            >
              <div className="orbit-node-dot" />
              <div className="orbit-node-name">{n.name.replace('Capital.com ', 'CAP ')}</div>
              <div className="orbit-node-meta">
                {n.status}
                {n.latency_ms != null ? ` · ${Math.round(n.latency_ms)}ms` : ''}
              </div>
            </div>
          ))}
        </div>

        <div className="orbit-side">
          <div className="card">
            <div className="section-title">SENDERS</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kind</th>
                    <th>Trust</th>
                    <th>Status</th>
                    <th>OK/Fail</th>
                  </tr>
                </thead>
                <tbody>
                  {senders.map((s) => (
                    <tr key={s.sender_id}>
                      <td>{s.name}</td>
                      <td className="mono">{s.kind}</td>
                      <td className="mono">{s.trust}</td>
                      <td>
                        <span
                          className={`badge ${
                            s.status === 'LIVE'
                              ? 'badge-healthy'
                              : s.status === 'ERROR'
                                ? 'badge-unhealthy'
                                : 'badge-mode'
                          }`}
                        >
                          {s.status}
                        </span>
                      </td>
                      <td className="mono">
                        {s.reads_ok}/{s.reads_fail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="section-title">SIMULTANEOUS READS</div>
            <div className="table-wrap" style={{ maxHeight: 360 }}>
              <table>
                <thead>
                  <tr>
                    <th>Sender</th>
                    <th>Epic</th>
                    <th>Bid</th>
                    <th>Ask</th>
                    <th>Mid</th>
                    <th>Ms</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(scan?.reads || []).map((r, i) => (
                    <tr key={`${r.sender_id}-${r.epic}-${i}`} className={r.ok ? '' : 'row-bad'}>
                      <td>{r.name}</td>
                      <td className="mono">{r.epic}</td>
                      <td className="mono">{fmt(r.bid)}</td>
                      <td className="mono">{fmt(r.ask)}</td>
                      <td className="mono">{fmt(r.mid)}</td>
                      <td className="mono">{r.latency_ms}</td>
                      <td className="mono" style={{ maxWidth: 220, whiteSpace: 'normal' }}>
                        {r.ok ? r.market_status || 'OK' : r.detail || 'fail'}
                      </td>
                    </tr>
                  ))}
                  {!scan?.reads?.length && (
                    <tr>
                      <td colSpan={7} className="mono">
                        Orbiting… waiting for first trusted read
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="hint-line" style={{ marginTop: 8 }}>
              Focus epic reads: {focusReads.filter((r) => r.ok).length}/{focusReads.length} ok · last scan{' '}
              {scan?.scanned_at ? new Date(scan.scanned_at).toLocaleTimeString() : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
