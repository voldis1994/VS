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

const POPULAR = ['GOLD', 'SILVER', 'US100', 'US500', 'OIL_CRUDE', 'BTCUSD', 'ETHUSD', 'EURUSD'];

export function DeskScreen() {
  const d = useDeskContext();
  const phase = d.status?.robot_status || 'STOPPED';
  const ticker = d.epic || d.status?.market || '—';
  const mid = d.quote?.mid ?? null;
  const regime = d.quote?.regime || d.status?.live_trade?.regime || null;

  const pickList = (() => {
    const byEpic = new Map(d.markets.map((m) => [m.epic, m]));
    const popular = POPULAR.map((e) => byEpic.get(e)).filter(Boolean) as typeof d.markets;
    const rest = d.markets.filter((m) => !POPULAR.includes(m.epic)).slice(0, 40);
    const merged = [...popular, ...rest];
    // Always include selected even if not in popular/rest slice
    for (const e of d.epics) {
      const m = byEpic.get(e);
      if (m && !merged.some((x) => x.epic === e)) merged.unshift(m);
    }
    return merged;
  })();

  return (
    <div className="m-app">
      <header className="m-top">
        <div className="m-top-left">
          <div className="m-asset-icon" aria-hidden />
          <div className="m-top-titles">
            <div className="m-market-select" style={{ fontWeight: 700, letterSpacing: '0.04em' }}>
              {ticker}
            </div>
            <div className="m-top-sub mono">{d.status?.client_name || '—'}</div>
          </div>
        </div>
        <div className="m-top-right">
          <button type="button" className="m-icon-btn" onClick={() => void d.logout()} aria-label="Exit">
            ✕
          </button>
        </div>
      </header>

      <section className="m-markets-pick" style={{ padding: '0 14px 8px' }}>
        <div className="m-top-sub" style={{ marginBottom: 6 }}>
          Markets 1–3 · Capital names
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {pickList.map((m) => {
            const on = d.epics.includes(m.epic);
            const focus = d.epic === m.epic;
            return (
              <button
                key={m.epic}
                type="button"
                disabled={d.requestedActive || d.busy}
                onClick={() => {
                  if (on) {
                    if (focus) void d.toggleMarket(m.epic);
                    else d.setFocusEpic(m.epic);
                  } else {
                    void d.toggleMarket(m.epic);
                  }
                }}
                onDoubleClick={() => void d.toggleMarket(m.epic)}
                className="m-phase"
                style={{
                  border: focus ? '1px solid #2dd4bf' : '1px solid transparent',
                  opacity: on ? 1 : 0.55,
                  cursor: 'pointer',
                  background: on ? 'rgba(45,212,191,0.15)' : undefined,
                }}
                title={on ? 'Selected — tap to focus, double-tap to remove' : 'Add market'}
              >
                {m.epic}
              </button>
            );
          })}
        </div>
        <div className="m-top-sub mono" style={{ marginTop: 6 }}>
          Selected: {d.epics.join(' · ') || '—'}
        </div>
      </section>

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
        budgetPct={d.budgetPct}
        estimatedLot={d.estimatedLot}
        locked={d.requestedActive}
        busy={d.busy}
        running={d.requestedActive}
        onStop={() => void d.stopRobot()}
        onStart={() => void d.startRobot()}
        onBudgetBump={(dir) => void d.bumpBudget(dir)}
        onBudgetInput={d.setBudgetInput}
      />
    </div>
  );
}
