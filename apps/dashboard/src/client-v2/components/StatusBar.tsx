export function StatusBar({
  linkOk,
  online,
  broker,
  pipeline,
  clientName,
}: {
  linkOk: boolean;
  online: boolean;
  broker?: string;
  pipeline?: boolean;
  clientName?: string;
}) {
  return (
    <footer className="aurum-statusbar">
      <div className="aurum-statusbar-left">
        <span className={`aurum-pulse ${linkOk ? 'on' : 'off'}`} />
        <span className="aurum-statusbar-text">
          {!online || !linkOk ? 'LINK DOWN' : 'LINK SECURE'}
        </span>
      </div>
      <div className="aurum-statusbar-mid">{clientName || '—'}</div>
      <div className="aurum-statusbar-right">
        <span className={broker === 'CONNECTED' ? 'ok' : broker === 'DEGRADED' ? 'warn' : ''}>
          BRK
        </span>
        <span className={pipeline ? 'ok' : 'warn'}>MC</span>
      </div>
    </footer>
  );
}
