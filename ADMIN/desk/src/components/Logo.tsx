export function Logo({
  size = 48,
  className,
  wordmark = false,
}: {
  size?: number;
  className?: string;
  wordmark?: boolean;
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
            <span className="vs-letter-v">V</span>
            <span className="vs-letter-s">S</span>
          </span>
          <span className="vs-wordmark-sub">TACTICAL DESK</span>
        </span>
      )}
    </span>
  );
}
