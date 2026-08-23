export function LotControl({
  lot,
  min,
  max,
  step,
  locked,
  busy,
  onBump,
}: {
  lot: number;
  min: number;
  max: number;
  step: number;
  locked: boolean;
  busy: boolean;
  onBump: (dir: -1 | 1) => void;
}) {
  return (
    <div className="aurum-lot">
      <div className="aurum-lot-head">
        <span className="aurum-kicker">Position size</span>
        <span className="aurum-lot-meta">
          {min} – {max} · step {step}
        </span>
      </div>
      <div className="aurum-lot-row">
        <button
          type="button"
          className="aurum-lot-btn"
          disabled={locked || busy}
          onClick={() => onBump(-1)}
          aria-label="Decrease lot"
        >
          −
        </button>
        <div className="aurum-lot-value">
          <span className="aurum-lot-num">{lot}</span>
          <span className="aurum-lot-unit">LOT</span>
        </div>
        <button
          type="button"
          className="aurum-lot-btn"
          disabled={locked || busy}
          onClick={() => onBump(1)}
          aria-label="Increase lot"
        >
          +
        </button>
      </div>
    </div>
  );
}
