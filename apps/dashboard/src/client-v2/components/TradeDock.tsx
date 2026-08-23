import { fmtLot, fmtPrice, fmtSpread } from '../lib/format';

export function TradeDock({
  bid,
  ask,
  spread,
  lot,
  min,
  max,
  step,
  locked,
  busy,
  running,
  onStop,
  onStart,
  onLotBump,
  onLotInput,
}: {
  bid: number | null;
  ask: number | null;
  spread: number | null;
  lot: number;
  min: number;
  max: number;
  step: number;
  locked: boolean;
  busy: boolean;
  running: boolean;
  onStop: () => void;
  onStart: () => void;
  onLotBump: (dir: -1 | 1) => void;
  onLotInput: (value: string) => void;
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
          onClick={() => onLotBump(-1)}
          aria-label="Decrease lot"
        >
          −
        </button>
        <label className="m-dock-lot-field">
          <span className="m-dock-lot-label">Lot size</span>
          <input
            className="m-dock-lot-input"
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            value={lot}
            disabled={locked || busy}
            onChange={(e) => onLotInput(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="m-dock-lot-btn"
          disabled={locked || busy}
          onClick={() => onLotBump(1)}
          aria-label="Increase lot"
        >
          +
        </button>
      </div>

      <div className="m-dock-meta mono">
        <span>
          {min} – {max} · step {step}
        </span>
        <span>{running ? 'ROBOT ON' : 'ROBOT OFF'}</span>
      </div>
    </footer>
  );
}
