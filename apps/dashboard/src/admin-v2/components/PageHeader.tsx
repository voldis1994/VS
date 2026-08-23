import type { ReactNode } from 'react';

type Stat = { label: string; value: string | number };

export function PageHeader({
  kicker,
  title,
  stats,
  actions,
}: {
  kicker: string;
  title: string;
  stats?: Stat[];
  actions?: ReactNode;
}) {
  return (
    <header className="cmd-page-head">
      <div className="cmd-page-titles">
        <div className="cmd-kicker">{kicker}</div>
        <h1 className="cmd-page-title">{title}</h1>
      </div>
      {stats && stats.length > 0 && (
        <div className="cmd-stat-row">
          {stats.map((s) => (
            <div key={s.label} className="cmd-stat">
              <span>{s.label}</span>
              <strong>{s.value}</strong>
            </div>
          ))}
        </div>
      )}
      {actions && <div className="cmd-page-actions">{actions}</div>}
    </header>
  );
}
