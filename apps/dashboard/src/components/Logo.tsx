export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Market Reader"
      style={{ filter: 'drop-shadow(0 0 10px rgba(168,85,247,0.65))' }}
    >
      <defs>
        <linearGradient id="mrVol" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="#C084FC" />
          <stop offset="1" stopColor="#39FF14" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="12" stroke="url(#mrVol)" strokeWidth="2" fill="#0b0814" />
      <path d="M16 44V20h8l8 16 8-16h8v24h-7V30l-7.5 14h-3L23 30v14H16z" fill="url(#mrVol)" />
      <circle cx="50" cy="14" r="3" fill="#39FF14" />
    </svg>
  );
}
