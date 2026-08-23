import { useEffect, useMemo, useRef, useState } from 'react';
import { filterMarkets, marketKey, type MarketOption } from '../lib/markets';

export function MarketSearchPicker({
  markets,
  value,
  onChange,
  disabled,
  placeholder = 'Meklē tirgu… gold, XAU, epic',
}: {
  markets: MarketOption[];
  value: string;
  onChange: (epic: string, market: MarketOption | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => markets.find((m) => marketKey(m) === value) || null,
    [markets, value],
  );

  const filtered = useMemo(() => filterMarkets(markets, query, 80), [markets, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery(selected ? `${selected.display_name} · ${marketKey(selected)}` : '');
    }
  }, [open, selected]);

  const pick = (m: MarketOption) => {
    const epic = marketKey(m);
    onChange(epic, m);
    setQuery(`${m.display_name} · ${epic}`);
    setOpen(false);
  };

  return (
    <div className={`cmd-market-picker ${open ? 'open' : ''}`} ref={wrapRef}>
      <input
        className="cmd-input cmd-market-picker-input"
        type="search"
        value={query}
        disabled={disabled || !markets.length}
        placeholder={markets.length ? placeholder : 'Nav tirgu — Pull Capital markets'}
        onFocus={() => {
          setOpen(true);
          if (selected) setQuery('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && filtered[0]) {
            e.preventDefault();
            pick(filtered[0]);
          }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && filtered.length > 0 && (
        <ul className="cmd-market-picker-list" role="listbox">
          {filtered.map((m) => {
            const epic = marketKey(m);
            const on = epic === value;
            return (
              <li key={`${m.instrument_id ?? epic}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`cmd-market-picker-item ${on ? 'on' : ''}`}
                  onClick={() => pick(m)}
                >
                  <span className="cmd-market-picker-name">{m.display_name}</span>
                  <span className="cmd-market-picker-epic mono">{epic}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && query.trim() && filtered.length === 0 && (
        <div className="cmd-market-picker-empty mono">Nav rezultātu — mēģini &quot;gold&quot;, &quot;xau&quot;</div>
      )}
      {markets.length > 0 && (
        <div className="cmd-market-picker-meta mono">
          {markets.length.toLocaleString()} tirgi · rāda līdz 80
        </div>
      )}
    </div>
  );
}
