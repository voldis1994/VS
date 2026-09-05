import { useEffect, useMemo, useRef, useState } from 'react';

export type SearchableOption = {
  value: string;
  label: string;
  searchText?: string;
};

type Props = {
  options: SearchableOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  /** Called when the dropdown opens (e.g. lazy-load options). */
  onOpen?: () => void;
};

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  emptyLabel = 'None',
  disabled = false,
  style,
  onOpen,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) || null;

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const hay = (o.searchText || o.label).toLowerCase();
      return hay.includes(q) || o.value.toLowerCase().includes(q);
    });
  }, [options, query]);

  const toggle = () => {
    if (disabled) return;
    setOpen((v) => {
      const next = !v;
      if (next) onOpen?.();
      return next;
    });
  };

  return (
    <div ref={rootRef} className="searchable-select" style={{ position: 'relative', ...style }}>
      <button
        type="button"
        className="input"
        disabled={disabled}
        onClick={toggle}
        style={{
          width: '100%',
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {selected ? selected.label : emptyLabel}
      </button>
      {open && (
        <div
          className="searchable-select-menu"
          style={{
            position: 'absolute',
            zIndex: 40,
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            minWidth: 260,
            maxHeight: 280,
            overflow: 'auto',
            background: 'var(--bg-elevated, #12141a)',
            border: '1px solid var(--border, #2a2f3a)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            padding: 8,
          }}
        >
          <input
            className="input"
            autoFocus
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: '100%', marginBottom: 8 }}
          />
          <button
            type="button"
            className="btn"
            style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 4 }}
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
          >
            {emptyLabel}
          </button>
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              className="btn"
              style={{
                width: '100%',
                justifyContent: 'flex-start',
                marginBottom: 2,
                opacity: o.value === value ? 1 : 0.9,
                borderColor: o.value === value ? 'var(--accent)' : undefined,
              }}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="empty-state" style={{ padding: 12, fontSize: 12 }}>
              No matches
            </div>
          )}
        </div>
      )}
    </div>
  );
}
