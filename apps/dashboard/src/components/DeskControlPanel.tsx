import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import {
  DeskAccount,
  isCapitalAccount,
  pickBestTradingAccount,
} from './DeskContext';

export const ALL_DESK_REGIMES = [
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
  'TRANSITION',
] as const;

export type DeskCalibration = {
  hardinv_abs: number;
  peak_mfe_abs: number;
  peak_retention: number;
  peak_min_giveback_abs: number;
  target_abs: number;
  safety_tp_rr: number;
  entry_filter_level?: number;
  hardinv_pct: number;
  target_pct: number;
  peak_mfe_pct: number;
  enabled_regimes: string[];
  updated_at?: string;
};

export type AutoCalStatus = {
  client_id?: number;
  enabled: boolean;
  session_started_at: string | null;
  closes_in_session: number;
  closes_until_next: number;
  cycles_run: number;
  last_cycle_at: string | null;
  last_summary: string | null;
  last_changes: string[];
  cooling_down?: boolean;
  cooldown_left_s?: number;
  session_sum_pts?: number;
  session_expectancy_pts?: number;
  session_wins?: number;
  session_losses?: number;
  last_window_expectancy?: number | null;
  history?: Array<{
    at: string;
    summary: string;
    changes: string[];
    applied: boolean;
    window_expectancy: number;
    window_sum_pts: number;
  }>;
  knobs_now?: {
    hardinv_abs: number;
    peak_mfe_abs: number;
    peak_retention: number;
    target_abs: number;
    safety_tp_rr?: number;
    entry_filter_level?: number;
    enabled_regimes: number;
  };
};

type MarketOpt = {
  instrument_id: number;
  epic?: string;
  symbol: string;
  display_name: string;
  min_lot: number;
  lot_size: number;
};

type Props = {
  /** compact = fit viewport on Robot Board (no page scroll for the 4 panels) */
  variant?: 'board' | 'command';
  onStarted?: (args: {
    accountId: number;
    epic: string;
    lot: number;
    name: string;
  }) => void;
};

export function DeskControlPanel({ variant = 'board', onStarted }: Props) {
  const [accounts, setAccounts] = useState<DeskAccount[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [markets, setMarkets] = useState<MarketOpt[]>([]);
  const [marketFilter, setMarketFilter] = useState('');
  const [marketEpic, setMarketEpic] = useState('');
  const [lotSize, setLotSize] = useState('0.1');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [cal, setCal] = useState<DeskCalibration | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calMsg, setCalMsg] = useState<string | null>(null);
  const [auto, setAuto] = useState<AutoCalStatus | null>(null);

  const clientIdForCal =
    accounts.find((a) => a.account_id === accountId)?.client_id ?? null;
  const calQs = clientIdForCal ? `?client_id=${clientIdForCal}` : '';

  useEffect(() => {
    void apiFetch<DeskAccount[]>('/api/trading/accounts')
      .then((rows) => {
        const list = rows || [];
        setAccounts(list);
        setAccountId((prev) => {
          if (prev && list.some((a) => a.account_id === prev)) {
            const still = list.find((a) => a.account_id === prev)!;
            if (isCapitalAccount(still) && (still.capital_market_count || 0) > 0) return prev;
          }
          return pickBestTradingAccount(list)?.account_id ?? list[0]?.account_id ?? null;
        });
      })
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    const load = () => {
      void apiFetch<{ calibration: DeskCalibration; auto?: AutoCalStatus }>(
        `/api/desk/calibration${calQs}`
      )
        .then((res) => {
          setCal(res.calibration);
          if (res.auto) setAuto(res.auto);
        })
        .catch(() => setCal(null));
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [calQs]);

  useEffect(() => {
    if (!accountId) {
      setMarkets([]);
      setMarketEpic('');
      return;
    }
    void apiFetch<MarketOpt[]>(`/api/trading/accounts/${accountId}/instruments`)
      .then((rows) => {
        const brokerRows = (rows || []).filter((r) => String(r.epic || '').trim().length > 0);
        setMarkets(brokerRows);
        setMarketEpic((prev) =>
          prev && brokerRows.some((r) => r.epic === prev) ? prev : '',
        );
      })
      .catch(() => {
        setMarkets([]);
        setMarketEpic('');
      });
  }, [accountId]);

  const capitalAccounts = useMemo(
    () =>
      [...accounts]
        .filter(isCapitalAccount)
        .sort((a, b) => (b.capital_market_count || 0) - (a.capital_market_count || 0)),
    [accounts],
  );

  const selected = accounts.find((a) => a.account_id === accountId) || null;
  const selectedIsCapital = selected ? isCapitalAccount(selected) : false;
  const bestCapital = useMemo(() => pickBestTradingAccount(accounts), [accounts]);

  const filteredMarkets = useMemo(() => {
    const q = marketFilter.trim().toLowerCase();
    const onlyEpic = markets.filter((m) => String(m.epic || '').trim().length > 0);
    if (!q) return onlyEpic.slice(0, 200);
    return onlyEpic
      .filter(
        (m) =>
          String(m.display_name || '').toLowerCase().includes(q) ||
          String(m.epic).toLowerCase().includes(q),
      )
      .slice(0, 200);
  }, [markets, marketFilter]);

  const selectedMarket = markets.find((m) => m.epic === marketEpic) || null;

  const saveCalibration = async (patch: Partial<DeskCalibration>) => {
    if (!cal) return;
    setCalBusy(true);
    setCalMsg(null);
    try {
      const res = await apiFetch<{ calibration: DeskCalibration }>(`/api/desk/calibration${calQs}`, {
        method: 'PUT',
        body: JSON.stringify({ ...cal, ...patch, client_id: clientIdForCal }),
      });
      setCal(res.calibration);
      setCalMsg('Saved');
    } catch (e) {
      setCalMsg(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setCalBusy(false);
    }
  };

  const toggleRegime = (name: string) => {
    if (!cal) return;
    const on = cal.enabled_regimes.includes(name);
    const next = on
      ? cal.enabled_regimes.filter((r) => r !== name)
      : [...cal.enabled_regimes, name];
    void saveCalibration({ enabled_regimes: next });
  };

  const startRobot = () => {
    if (!accountId || !selectedMarket?.epic || !selectedIsCapital) {
      setMsg('Izvēlies Capital account + epic 1:1');
      return;
    }
    const lot = Number(lotSize);
    if (!Number.isFinite(lot) || lot <= 0) {
      setMsg('Lot size must be > 0');
      return;
    }
    const name = selectedMarket.display_name || selectedMarket.epic;
    setBusy(true);
    setMsg(null);
    if (onStarted) {
      onStarted({ accountId, epic: selectedMarket.epic, lot, name });
      setBusy(false);
      setMsg(`Started · ${name} · ${selectedMarket.epic}`);
      return;
    }
    window.open(
      `/robot/unit?account_id=${accountId}&epic=${encodeURIComponent(
        selectedMarket.epic,
      )}&lot=${lot}&name=${encodeURIComponent(name)}`,
      `robot_${accountId}_${selectedMarket.epic}`,
      'noopener,noreferrer',
    );
    setBusy(false);
    setMsg(`Unit page · ${name}`);
  };

  const rootClass =
    variant === 'board' ? 'desk-control desk-control-board' : 'desk-control desk-control-command';

  return (
    <div className={rootClass}>
      <div className="control-fit-bar">
        <div className="section-title" style={{ margin: 0 }}>
          CONTROL
        </div>
        <span className="hint-line" style={{ margin: 0 }}>
          Start · HardInv / Peak · Regimes — visas sadaļas vienā skatā
        </span>
      </div>

      <div className="desk-control-grid">
        <section className="panel control-panel">
          <div className="section-title">START ROBOT</div>
          <label className="field-label">Capital account</label>
          <select
            className="input"
            value={accountId ?? ''}
            onChange={(e) => {
              const id = Number(e.target.value);
              setAccountId(Number.isFinite(id) && id > 0 ? id : null);
            }}
          >
            <option value="">— select Capital —</option>
            {capitalAccounts.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.client_name} / {a.broker_name} ({a.environment}) ·{' '}
                {(a.capital_market_count || 0).toLocaleString()} mkts
              </option>
            ))}
          </select>
          {accountId && !selectedIsCapital && (
            <div className="error-state">
              Nav Capital.
              {bestCapital && isCapitalAccount(bestCapital) && (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginLeft: 6 }}
                  onClick={() => setAccountId(bestCapital.account_id)}
                >
                  Use {bestCapital.client_name}
                </button>
              )}
            </div>
          )}
          {accountId && selectedIsCapital && markets.length === 0 && (
            <div className="error-state">
              Nav tirgu. <Link to="/trading">Trading</Link> → Pull ALL
              {bestCapital &&
                bestCapital.account_id !== accountId &&
                (bestCapital.capital_market_count || 0) > 0 && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ marginLeft: 6 }}
                    onClick={() => setAccountId(bestCapital.account_id)}
                  >
                    {bestCapital.client_name} (
                    {(bestCapital.capital_market_count || 0).toLocaleString()})
                  </button>
                )}
            </div>
          )}
          <label className="field-label">Search</label>
          <input
            className="input"
            placeholder="Gold / XAUUSD…"
            value={marketFilter}
            onChange={(e) => setMarketFilter(e.target.value)}
            disabled={!markets.length}
          />
          <label className="field-label">Broker epic 1:1</label>
          <select
            className="input"
            value={marketEpic}
            onChange={(e) => {
              const epic = e.target.value;
              setMarketEpic(epic);
              const m = markets.find((x) => x.epic === epic);
              if (m) setLotSize(String(m.lot_size || m.min_lot || 0.1));
            }}
            disabled={!markets.length}
          >
            <option value="">— select epic —</option>
            {filteredMarkets.map((m) => (
              <option key={m.instrument_id} value={m.epic}>
                {m.display_name} · {m.epic}
              </option>
            ))}
          </select>
          <label className="field-label">Lot</label>
          <input
            className="input"
            value={lotSize}
            onChange={(e) => setLotSize(e.target.value)}
            disabled={!markets.length}
          />
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              className="btn btn-go"
              disabled={busy || !marketEpic || !accountId || !selectedIsCapital}
              onClick={startRobot}
            >
              TRADING ON → ROBOT
            </button>
          </div>
          {msg && <div className="hint-line">{msg}</div>}
        </section>

        <section className="panel control-panel">
          <div className="section-title">AUTO-CAL · ULTIMATE</div>
          <p className="hint-line" style={{ marginTop: 0, marginBottom: 6 }}>
            Sākumā tirgo VISU (entry filters OPEN). Ik pēc 5 closes pats koriģē
            Soft/Peak/Target + filters. Ja mērķi pārāk tālu — pullback (neceļ bezgalīgi).
            Core regimes nekad auto-OFF. Lot nemaina.
          </p>
          {auto ? (
            <>
              <div className="hint-line mono">
                {auto.enabled ? 'ON' : 'OFF'}
                {clientIdForCal ? ` · client #${clientIdForCal}` : ''}
                {auto.cooling_down
                  ? ` · COOLDOWN ${auto.cooldown_left_s ?? 0}s`
                  : ` · closes ${auto.closes_in_session} · next ${auto.closes_until_next}`}
                {' · '}cycles {auto.cycles_run}
              </div>
              <div className="hint-line mono" style={{ marginTop: 4 }}>
                Session E={Number(auto.session_expectancy_pts ?? 0).toFixed(2)} · sum{' '}
                {Number(auto.session_sum_pts ?? 0).toFixed(2)} · W/L {auto.session_wins ?? 0}/
                {auto.session_losses ?? 0}
              </div>
              {auto.knobs_now && (
                <div className="hint-line mono" style={{ marginTop: 2 }}>
                  Knobs Soft {auto.knobs_now.hardinv_abs} · Peak {auto.knobs_now.peak_mfe_abs}/
                  {Math.round(auto.knobs_now.peak_retention * 100)}% · Target {auto.knobs_now.target_abs} ·
                  regimes {auto.knobs_now.enabled_regimes}
                </div>
              )}
              {cal && (
                <div className="hint-line mono" style={{ marginTop: 4 }}>
                  Entry filters L{cal.entry_filter_level ?? 0} ·{' '}
                  {(cal.entry_filter_level ?? 0) === 0
                    ? 'OPEN'
                    : (cal.entry_filter_level ?? 0) === 1
                      ? 'FLIP lock'
                      : (cal.entry_filter_level ?? 0) === 2
                        ? 'FLIP+structure'
                        : 'STRICT'}
                </div>
              )}
              {auto.last_summary && (
                <div className="hint-line" style={{ marginTop: 4 }}>
                  Last: {auto.last_summary}
                </div>
              )}
              {auto.last_changes?.length > 0 && (
                <div className="hint-line" style={{ marginTop: 2 }}>
                  Changed: {auto.last_changes.join(' · ')}
                </div>
              )}
              <div className="actions" style={{ marginTop: 6, gap: 6 }}>
                <button
                  className="btn"
                  disabled={calBusy}
                  onClick={() => {
                    void apiFetch<{ auto: AutoCalStatus }>('/api/desk/auto-calibrate', {
                      method: 'POST',
                      body: JSON.stringify({
                        enabled: !auto.enabled,
                        client_id: clientIdForCal,
                      }),
                    }).then((r) => setAuto(r.auto));
                  }}
                >
                  {auto.enabled ? 'Pause auto' : 'Resume auto'}
                </button>
                <button
                  className="btn"
                  disabled={calBusy}
                  onClick={() => {
                    void apiFetch<{ auto: AutoCalStatus }>('/api/desk/auto-calibrate', {
                      method: 'POST',
                      body: JSON.stringify({ reset: true, client_id: clientIdForCal }),
                    }).then((r) => setAuto(r.auto));
                  }}
                >
                  Reset watch
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">Auto-cal loading…</div>
          )}
        </section>

        <section className="panel control-panel">
          <div className="section-title">EXIT CALIBRATION</div>
          {!cal && <div className="empty-state">Loading…</div>}
          {cal && (
            <>
              <label className="field-label">HardInv abs</label>
              <input
                className="input"
                type="number"
                step="0.1"
                value={cal.hardinv_abs}
                disabled={calBusy}
                onChange={(e) => setCal({ ...cal, hardinv_abs: Number(e.target.value) })}
                onBlur={() => void saveCalibration({ hardinv_abs: cal.hardinv_abs })}
              />
              <label className="field-label">Peak keep % (75=25% giveback)</label>
              <input
                className="input"
                type="number"
                step="1"
                min={50}
                max={95}
                value={Math.round(cal.peak_retention * 100)}
                disabled={calBusy}
                onChange={(e) =>
                  setCal({ ...cal, peak_retention: Number(e.target.value) / 100 })
                }
                onBlur={() => void saveCalibration({ peak_retention: cal.peak_retention })}
              />
              <label className="field-label">Peak MFE floor</label>
              <input
                className="input"
                type="number"
                step="0.1"
                value={cal.peak_mfe_abs}
                disabled={calBusy}
                onChange={(e) => setCal({ ...cal, peak_mfe_abs: Number(e.target.value) })}
                onBlur={() => void saveCalibration({ peak_mfe_abs: cal.peak_mfe_abs })}
              />
              <label className="field-label">Peak min giveback</label>
              <input
                className="input"
                type="number"
                step="0.05"
                value={cal.peak_min_giveback_abs}
                disabled={calBusy}
                onChange={(e) =>
                  setCal({ ...cal, peak_min_giveback_abs: Number(e.target.value) })
                }
                onBlur={() =>
                  void saveCalibration({ peak_min_giveback_abs: cal.peak_min_giveback_abs })
                }
              />
              <label className="field-label">Target abs</label>
              <input
                className="input"
                type="number"
                step="0.1"
                value={cal.target_abs}
                disabled={calBusy}
                onChange={(e) => setCal({ ...cal, target_abs: Number(e.target.value) })}
                onBlur={() => void saveCalibration({ target_abs: cal.target_abs })}
              />
              <label className="field-label">Broker TP R:R (vs SL)</label>
              <input
                className="input"
                type="number"
                step="0.05"
                min={1.5}
                max={4}
                value={cal.safety_tp_rr}
                disabled={calBusy}
                onChange={(e) => setCal({ ...cal, safety_tp_rr: Number(e.target.value) })}
                onBlur={() => void saveCalibration({ safety_tp_rr: cal.safety_tp_rr })}
              />
              <p className="hint-line" style={{ marginTop: 2 }}>
                Auto-cal maina šo — Capital SAFETY TP. SL paliek kā atvērts.
              </p>
              <label className="field-label">Entry filter level (0–3)</label>
              <input
                className="input"
                type="number"
                step="1"
                min={0}
                max={3}
                value={cal.entry_filter_level ?? 0}
                disabled={calBusy}
                onChange={(e) =>
                  setCal({ ...cal, entry_filter_level: Number(e.target.value) })
                }
                onBlur={() =>
                  void saveCalibration({ entry_filter_level: cal.entry_filter_level ?? 0 })
                }
              />
              <p className="hint-line" style={{ marginTop: 2 }}>
                0=OPEN · 1=flip · 2=+structure · 3=strict. Auto-cal paceļ/pazemina pēc closes.
              </p>
              <div className="actions" style={{ marginTop: 6 }}>
                <button
                  className="btn btn-primary"
                  disabled={calBusy}
                  onClick={() => void saveCalibration({})}
                >
                  Save knobs
                </button>
              </div>
              {calMsg && <div className="hint-line">{calMsg}</div>}
            </>
          )}
        </section>

        <section className="panel control-panel">
          <div className="section-title">TRADE REGIMES</div>
          <p className="hint-line" style={{ marginTop: 0, marginBottom: 6 }}>
            Entry tikai ieslēgtajos.
          </p>
          <div className="regime-catalog desk-control-regimes">
            {ALL_DESK_REGIMES.map((name) => {
              const on = Boolean(cal?.enabled_regimes.includes(name));
              return (
                <button
                  key={name}
                  type="button"
                  className={`regime-chip ${on ? 'on' : ''} ${
                    name.includes('UP') || name === 'EXPANSION'
                      ? 'up'
                      : name.includes('DOWN') || name === 'COMPRESSION'
                        ? 'down'
                        : name.includes('BREAKOUT') || name === 'REVERSAL_CANDIDATE'
                          ? 'scalp'
                          : 'flat'
                  }`}
                  disabled={calBusy || !cal}
                  onClick={() => toggleRegime(name)}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <div className="actions" style={{ marginTop: 6 }}>
            <button
              className="btn"
              disabled={calBusy || !cal}
              onClick={() => void saveCalibration({ enabled_regimes: [...ALL_DESK_REGIMES] })}
            >
              All on
            </button>
            <button
              className="btn"
              disabled={calBusy || !cal}
              onClick={() => void saveCalibration({ enabled_regimes: [] })}
            >
              All off
            </button>
          </div>
        </section>

        <section className="panel control-panel">
          <div className="section-title">ACCOUNT</div>
          {selected ? (
            <>
              <div className="metric-box" style={{ marginBottom: 6 }}>
                <div className="label">Selected</div>
                <div className="value" style={{ fontSize: 12 }}>
                  {selected.display_name}
                </div>
              </div>
              <div className="metric-row">
                <div className="metric-box">
                  <div className="label">Env</div>
                  <div className="value" style={{ fontSize: 11 }}>{selected.environment}</div>
                </div>
                <div className="metric-box">
                  <div className="label">Markets</div>
                  <div className="value" style={{ fontSize: 11 }}>
                    {(selected.capital_market_count || 0).toLocaleString()}
                  </div>
                </div>
              </div>
              <div className="actions" style={{ marginTop: 8 }}>
                <Link className="btn" to="/trading">
                  Trading
                </Link>
                {variant === 'command' && (
                  <Link className="btn btn-primary" to="/robot">
                    Robot Board
                  </Link>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">Nav Capital account</div>
          )}
        </section>
      </div>
    </div>
  );
}
