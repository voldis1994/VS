import type { ClientLive } from '../lib/useClientLive';

const PRESETS = [0.01, 0.05, 0.1, 0.5, 1];

export function HomePage({ live }: { live: ClientLive }) {
  return (
    <>
      <div className="card">
        <div className="welcome">WELCOME</div>
        <div className="name">{live.clientName || 'Client'}</div>
        <div className={`status ${live.accountRunning ? '' : 'off'}`}>
          ● ACCOUNT {live.accountRunning ? 'RUNNING' : 'STOPPED'}
        </div>
      </div>

      <div className="card">
        <div className="market-title">
          <strong>XAU/USD</strong>
          <span className="live">● {live.marketStatus}</span>
        </div>
        <div className="price">{live.price == null ? '—' : live.price.toFixed(2)}</div>
        <div className="row"><span>BID</span><span>{live.bid ?? '—'}</span></div>
        <div className="row"><span>ASK</span><span>{live.ask ?? '—'}</span></div>
        <div className="row"><span>SPREAD</span><span>{live.spread ?? '—'}</span></div>
        <div className="chart-empty">NO CHART — waiting for authorized live ticks</div>
      </div>

      <div className="card">
        <div className="muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>LOT SIZE</div>
        <div className="lot">
          <button type="button" onClick={() => live.setLot(Math.max(0.01, +(live.lot - 0.01).toFixed(2)))}>−</button>
          <div className="val">{live.lot.toFixed(2)}</div>
          <button type="button" onClick={() => live.setLot(+(live.lot + 0.01).toFixed(2))}>+</button>
        </div>
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={live.lot === p ? 'on' : ''}
              onClick={() => live.setLot(p)}
            >
              {p.toFixed(2)}
            </button>
          ))}
        </div>
      </div>

      <div className="start-wrap">
        <button
          type="button"
          className={`start ${live.tradingOn ? 'stop' : ''}`}
          onClick={() => void live.toggleTrading()}
        >
          <div>
            VS
            <small>{live.tradingOn ? 'STOP' : 'START'}</small>
          </div>
        </button>
      </div>
      <div className="conn">
        START enables strategy participation on VS CORE — not an instant BUY.
      </div>
    </>
  );
}
