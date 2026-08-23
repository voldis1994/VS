import { PriceChart } from '../components/PriceChart';
import { PositionTicket } from '../components/PositionTicket';
import { TradeDock } from '../components/TradeDock';
import { useDeskContext } from '../DeskContext';
import { fmtPrice } from '../lib/format';

const PHASE_LABEL: Record<string, string> = {
  RUNNING: 'LIVE',
  STARTING: 'ARMING',
  STOPPED: 'OFF',
  ERROR: 'FAULT',
};

export function DeskScreen() {
  const d = useDeskContext();
  const phase = d.status?.robot_status || 'STOPPED';
  const displayName = d.selected?.display_name || d.status?.display_name || d.epic || 'Market';
  const mid = d.quote?.mid ?? null;
  const regime = d.quote?.regime || d.status?.live_trade?.regime || null;

  return (
    <div className="m-app">
      <header className="m-top">
        <div className="m-top-left">
          <div className="m-asset-icon" aria-hidden />
          <div className="m-top-titles">
            <select
              className="m-market-select"
              value={d.epic}
              disabled={d.requestedActive || d.busy}
              onChange={(e) => void d.onMarketChange(e.target.value)}
              aria-label="Market"
            >
              {!d.markets.length && <option value="">No markets</option>}
              {d.markets.map((m) => (
                <option key={m.instrument_id} value={m.epic}>
                  {m.display_name}
                </option>
              ))}
            </select>
            <div className="m-top-sub mono">{d.status?.client_name || '—'}</div>
          </div>
        </div>
        <div className="m-top-right">
          <button type="button" className="m-icon-btn" onClick={() => void d.logout()} aria-label="Exit">
            ✕
          </button>
        </div>
      </header>

      <section className="m-price-block">
        <div className="m-price-main mono">{fmtPrice(mid)}</div>
        <div className="m-price-meta">
          {d.quote?.change_pct != null && (
            <span className={d.quote.change_pct >= 0 ? 'up' : 'down'}>
              {d.quote.change_pct >= 0 ? '+' : ''}
              {d.quote.change_pct.toFixed(2)}%
            </span>
          )}
          {regime && regime !== 'UNKNOWN' && <span className="m-regime">{regime}</span>}
          <span className={`m-phase m-phase--${phase.toLowerCase()}`}>{PHASE_LABEL[phase] || phase}</span>
        </div>
      </section>

      <section className="m-chart-wrap">
        <PriceChart prices={d.priceHistory} />
        <div className="m-timeframes" aria-hidden>
          <span className="on">LIVE</span>
          <span>10s</span>
        </div>
      </section>

      <section className={`m-trades ${d.tradesOpen ? 'open' : ''}`}>
        <button
          type="button"
          className="m-trades-toggle"
          onClick={() => d.setTradesOpen((v) => !v)}
          aria-expanded={d.tradesOpen}
        >
          <span>Trades</span>
          <span className="m-trades-caret">{d.tradesOpen ? '▾' : '▸'}</span>
        </button>
        {d.tradesOpen && (
          <div className="m-trades-body">
            <PositionTicket
              live={d.status?.live_trade ?? null}
              flash={d.flash}
              closedBanner={d.closedBanner}
              waiting={d.confirmedRunning}
              phase={phase}
            />
          </div>
        )}
      </section>

      {d.error && <p className="aurum-error m-error">{d.error}</p>}

      <div className="m-status">
        <span className={`m-link-dot ${d.linkOk ? 'on' : ''}`} />
        <span>{d.linkOk ? 'Link secure' : 'Link down'}</span>
        <span className={d.status?.broker_status === 'CONNECTED' ? 'ok' : 'warn'}>
          BRK {d.status?.broker_status || '—'}
        </span>
        <span className={d.status?.pipeline_healthy ? 'ok' : 'warn'}>MC</span>
      </div>

      <TradeDock
        bid={d.quote?.bid ?? mid}
        ask={d.quote?.ask ?? mid}
        spread={d.quote?.spread ?? null}
        lot={d.lot}
        min={d.selected?.min_lot ?? 0.01}
        max={d.selected?.max_lot ?? 100}
        step={d.selected?.lot_step ?? 0.01}
        locked={d.requestedActive}
        busy={d.busy}
        running={d.requestedActive}
        onStop={() => void d.stopRobot()}
        onStart={() => void d.startRobot()}
        onLotBump={(dir) => void d.bumpLot(dir)}
        onLotInput={d.setLotInput}
      />
    </div>
  );
}
