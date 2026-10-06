export function Logo({
  size = 48,
  className,
  wordmark = false,
  sub = 'DESK',
}: {
  size?: number;
  className?: string;
  wordmark?: boolean;
  /** Wordmark subtitle under VS SYSTEM */
  sub?: string;
}) {
  return (
    <span className={className ? `vs-logo-wrap ${className}` : 'vs-logo-wrap'}>
      <img
        src="/logo.svg"
        width={size}
        height={size}
        alt=""
        className="vs-logo-mark"
        draggable={false}
        style={{ width: size, height: size }}
      />
      {wordmark && (
        <span className="vs-wordmark" aria-hidden={false}>
          <span className="vs-wordmark-main">
            <em className="vs-wordmark-vs">VS</em> SYSTEM
          </span>
          {sub.trim() ? <span className="vs-wordmark-sub">{sub}</span> : null}
        </span>
      )}
    </span>
  );
}
