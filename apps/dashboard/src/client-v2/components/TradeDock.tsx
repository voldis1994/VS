import { fmtLot, fmtPrice, fmtSpread } from '../lib/format';

export function TradeDock({
  bid,
  ask,
  spread,
  budgetPct,
  estimatedLot,
  locked,
  busy,
  running,
  onStop,
  onStart,
  onBudgetBump,
  onBudgetInput,
}: {
  bid: number | null;
  ask: number | null;
  spread: number | null;
  budgetPct: number;
  estimatedLot: number | null;
  locked: boolean;
  busy: boolean;
  running: boolean;
  onStop: () => void;
  onStart: () => void;
  onBudgetBump: (dir: -1 | 1) => void;
  onBudgetInput: (value: string) => void;
}) {
  return (
    <footer className="m-dock">
      <div className="m-dock-actions">
        <button
          type="button"
          className={`m-dock-btn m-dock-btn--stop ${running ? 'on' : ''}`}
          disabled={busy || !running}
          onClick={onStop}
        >
          <span className="m-dock-btn-label">Stop</span>
          <span className="m-dock-btn-price">{fmtPrice(bid)}</span>
        </button>
        <div className="m-dock-spread" aria-label="Spread">
          <span>{fmtSpread(spread)}</span>
          <span className="m-dock-spread-sub">spread</span>
        </div>
        <button
          type="button"
          className={`m-dock-btn m-dock-btn--start ${!running ? 'on' : ''}`}
          disabled={busy || running}
          onClick={onStart}
        >
          <span className="m-dock-btn-label">Start</span>
          <span className="m-dock-btn-price">{fmtPrice(ask)}</span>
        </button>
      </div>

      <div className="m-dock-lot">
        <button
          type="button"
          className="m-dock-lot-btn"
          disabled={locked || busy}
          onClick={() => onBudgetBump(-1)}
          aria-label="Decrease budget %"
        >
          −
        </button>
        <label className="m-dock-lot-field">
          <span className="m-dock-lot-label">Budget % of equity</span>
          <input
            className="m-dock-lot-input"
            type="number"
            inputMode="decimal"
            min={1}
            max={100}
            step={1}
            value={budgetPct}
            disabled={locked || busy}
            onChange={(e) => onBudgetInput(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="m-dock-lot-btn"
          disabled={locked || busy}
          onClick={() => onBudgetBump(1)}
          aria-label="Increase budget %"
        >
          +
        </button>
      </div>

      <div className="m-dock-meta mono">
        <span>
          ~{budgetPct}% margin · est lot {estimatedLot != null ? fmtLot(estimatedLot) : '—'}
        </span>
        <span>{running ? 'ROBOT ON' : 'ROBOT OFF'}</span>
      </div>
    </footer>
  );
}
