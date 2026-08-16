import type { LiveState } from '../hooks/useAdminLive';

export function PlaceholderPage({
  title,
  note,
  live,
  kind,
}: {
  title: string;
  note?: string;
  live?: LiveState;
  kind?: 'market' | 'incidents';
}) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      {kind === 'market' && live ? (
        <>
          <div>Status: {live.marketStatus}</div>
          <div className="muted">{live.marketDetail}</div>
          <div className="empty">NO FAKE CHART / NO SAMPLE QUOTES</div>
        </>
      ) : kind === 'incidents' && live ? (
        live.lastError ? (
          <div style={{ color: 'var(--red)' }}>{live.lastError}</div>
        ) : (
          <div className="empty">NO OPEN INCIDENTS</div>
        )
      ) : (
        <div className="empty">{note || 'NO DATA'}</div>
      )}
    </div>
  );
}
