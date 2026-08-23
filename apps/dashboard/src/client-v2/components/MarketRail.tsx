import type { Market } from '../types';

export function MarketRail({
  markets,
  epic,
  locked,
  onChange,
}: {
  markets: Market[];
  epic: string;
  locked: boolean;
  onChange: (epic: string) => void;
}) {
  if (!markets.length) {
    return (
      <div className="aurum-rail aurum-rail--empty">
        No markets — ask admin to pull Capital catalog
      </div>
    );
  }

  return (
    <div className="aurum-rail" role="listbox" aria-label="Market">
      {markets.map((m) => {
        const on = m.epic === epic;
        return (
          <button
            key={m.instrument_id}
            type="button"
            role="option"
            aria-selected={on}
            disabled={locked}
            className={`aurum-chip ${on ? 'on' : ''}`}
            onClick={() => onChange(m.epic)}
          >
            <span className="aurum-chip-name">{m.display_name}</span>
            <span className="aurum-chip-epic">{m.epic}</span>
          </button>
        );
      })}
    </div>
  );
}
