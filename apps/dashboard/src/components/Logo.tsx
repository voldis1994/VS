export function Logo({
  size = 40,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/logo.svg"
      width={size}
      height={size}
      alt=""
      className={className ? `brand-logo ${className}` : 'brand-logo'}
      draggable={false}
      style={{
        width: size,
        height: size,
        display: 'block',
        objectFit: 'contain',
        filter: 'drop-shadow(0 0 12px rgba(57, 255, 20, 0.45))',
      }}
    />
  );
}
