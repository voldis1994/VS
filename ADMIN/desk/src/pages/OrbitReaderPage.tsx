import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { Logo } from '../components/Logo';

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
  const [search, setSearch] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [spinDeg, setSpinDeg] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSpinDeg((d) => (d + 0.35) % 360), 32);
    return () => clearInterval(id);
  }, []);

  const loadOptions = useCallback(async (q = '') => {
    const qs = q.trim()
      ? `?limit=60&q=${encodeURIComponent(q.trim())}`
      : '?limit=60';
    try {
      const rows = await apiFetch<EpicOpt[]>(`/api/robot-reader/epics${qs}`);
      setOptions(rows);
      setEpics((prev) => {
        if (prev.length) return prev.filter((e) => rows.some((r) => r.epic === e) || prev.includes(e));
        return rows.slice(0, 3).map((r) => r.epic);
      });
    } catch {
      setOptions([]);
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    const t = setTimeout(() => void loadOptions(search), 250);
    return () => clearTimeout(t);
  }, [search, loadOptions]);

  const nameByEpic = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) m.set(o.epic, o.display_name);
    return m;
  }, [options]);

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
    const list = senders.length
      ? senders
      : [
          {
            sender_id: 'idle',
            name: 'Waiting',
            kind: 'idle',
            trust: '',
            status: 'IDLE',
            latency_ms: null,
            last_error: null,
            reads_ok: 0,
            reads_fail: 0,
          },
        ];
    return list.map((s, i) => {
      const angle = (360 / list.length) * i + spinDeg;
      const rad = (angle * Math.PI) / 180;
      const r = 118;
      return {
        ...s,
        x: Math.cos(rad) * r,
        y: Math.sin(rad) * r,
      };
    });
  }, [senders, spinDeg]);

  const focusConsensus = scan?.consensus?.[0];
  const focusEpic = scan?.epics?.[0] || epics[0] || '';
  const focusName = nameByEpic.get(focusEpic) || focusEpic || '—';

  const toggleEpic = (epic: string) => {
    setEpics((prev) =>
      prev.includes(epic) ? prev.filter((x) => x !== epic) : [...prev, epic].slice(0, 6),
    );
  };

  return (
    <div className="orbit-page">
      <div className="orbit-hero">
        <div className="dash-brand-hero">
          <Logo size={80} wordmark />
          <div>
            <div className="orbit-kicker">VS SYSTEM // SENSOR GRID</div>
            <h1 className="page-title">ORBIT READER</h1>
            <p className="page-subtitle">
              Capital.com name lock · multi-sender watch · real quotes only
            </p>
          </div>
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
            <span>Catalog</span>
            <strong>{options.length}</strong>
          </div>
        </div>
      </div>

      {error && <div className="error-state" style={{ marginBottom: 12 }}>{error}</div>}
      {options.length === 0 && (
        <div className="error-state" style={{ marginBottom: 12 }}>
          Nav Capital.com tirgu katalogā. Ej uz <Link to="/trading">Trading</Link> →{' '}
          <strong>Pull ALL Capital.com markets</strong> (Broker Test jābūt OK).
        </div>
      )}
      {scan?.note && <div className="orbit-note">{scan.note}</div>}

      <div className="orbit-controls card">
        <div className="section-title">WATCHLIST — Capital.com names (max 6)</div>
        <div className="orbit-chips">
          {epics.map((e) => (
            <button
              key={e}
              type="button"
              className="orbit-chip on"
              onClick={() => toggleEpic(e)}
              title={e}
            >
              {nameByEpic.get(e) || e} ×
            </button>
          ))}
        </div>
        <div className="actions" style={{ marginTop: 8 }}>
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Search Capital.com name / epic…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn btn-primary" type="button" onClick={() => void tick()} disabled={busy}>
            Scan now
          </button>
          <button className="btn" type="button" onClick={() => setRunning((v) => !v)}>
            {running ? 'Pause orbit' : 'Resume orbit'}
          </button>
          <Link className="btn btn-go" to="/trading">
            Trading BUY/SELL
          </Link>
        </div>
        <div className="orbit-chips" style={{ marginTop: 8, maxHeight: 140, overflow: 'auto' }}>
          {options.map((o) => (
            <button
              key={o.epic}
              type="button"
              className={`orbit-chip ${epics.includes(o.epic) ? 'on' : ''}`}
              onClick={() => toggleEpic(o.epic)}
              title={`epic: ${o.epic}`}
            >
              {o.display_name}
              <span style={{ opacity: 0.55, marginLeft: 6 }}>{o.epic}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="orbit-stage">
        <div className="orbit-ring-wrap">
          <div className="orbit-ring" style={{ transform: `rotate(${spinDeg}deg)` }} />
          <div className="orbit-ring orbit-ring-2" style={{ transform: `rotate(${-spinDeg * 1.4}deg)` }} />
          <div className="orbit-core">
            <div className="orbit-core-label">CONSENSUS</div>
            <div className="orbit-core-epic">{focusName}</div>
            <div className="mono" style={{ fontSize: 9, opacity: 0.7 }}>{focusEpic || '—'}</div>
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
                    <th>Status</th>
                    <th>OK/Fail</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {senders.map((s) => (
                    <tr key={s.sender_id}>
                      <td>{s.name}</td>
                      <td className="mono">{s.kind}</td>
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
                      <td className="mono" style={{ maxWidth: 280, whiteSpace: 'normal' }}>
                        {s.last_error || '—'}
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
                    <th>Capital name / epic</th>
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
                      <td>
                        <div>{nameByEpic.get(r.epic) || r.epic}</div>
                        <div className="mono">{r.epic}</div>
                      </td>
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
                        Orbiting… waiting for Capital quotes
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
