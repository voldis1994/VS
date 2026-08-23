import { fmtPrice } from '../lib/format';
import type { LiveTrade } from '../types';

export function PositionTicket({
  live,
  flash,
  closedBanner,
  waiting,
  phase,
}: {
  live: LiveTrade;
  flash: 'opened' | 'closed' | null;
  closedBanner: boolean;
  waiting: boolean;
  phase: string;
}) {
  const flashClass = flash === 'opened' ? 'flash-in' : flash === 'closed' ? 'flash-out' : '';

  if (closedBanner && !live) {
    return (
      <article className={`aurum-ticket ${flashClass}`}>
        <header className="aurum-ticket-head">
          <span className="aurum-kicker">Execution</span>
          <span className="aurum-ticket-badge dim">CLOSED</span>
        </header>
        <p className="aurum-ticket-empty">Trade finalized — robot still on watch</p>
      </article>
    );
  }

  if (live) {
    const sideClass = live.side === 'BUY' ? 'buy' : 'sell';
    return (
      <article className={`aurum-ticket live ${flashClass}`}>
        <header className="aurum-ticket-head">
          <span className="aurum-kicker">Open position</span>
          <span className={`aurum-ticket-badge ${sideClass}`}>{live.trade_type}</span>
        </header>
        <h2 className="aurum-ticket-market">{live.display_name || live.market}</h2>
        <div className="aurum-ticket-grid">
          <div>
            <span className="aurum-ticket-key">Side</span>
            <span className={`aurum-ticket-val ${sideClass}`}>{live.side}</span>
          </div>
          <div>
            <span className="aurum-ticket-key">Lot</span>
            <span className="aurum-ticket-val">{live.lot_size}</span>
          </div>
          <div>
            <span className="aurum-ticket-key">Entry</span>
            <span className="aurum-ticket-val mono">{fmtPrice(live.entry_price)}</span>
          </div>
          {live.regime && live.regime !== 'UNKNOWN' && (
            <div className="aurum-ticket-regime">
              <span className="aurum-ticket-key">Regime</span>
              <span className="aurum-ticket-val">{live.regime}</span>
            </div>
          )}
        </div>
      </article>
    );
  }

  let empty = 'Robot idle — arm to receive signals';
  if (waiting) empty = 'Scanning market — waiting for setup';
  if (phase === 'STARTING') empty = 'Linking pipeline & feeds';
  if (phase === 'ERROR') empty = 'Check broker / market configuration';

  return (
    <article className="aurum-ticket">
      <header className="aurum-ticket-head">
        <span className="aurum-kicker">Execution</span>
        <span className="aurum-ticket-badge dim">FLAT</span>
      </header>
      <p className="aurum-ticket-empty">{empty}</p>
    </article>
  );
}
