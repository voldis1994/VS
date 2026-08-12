export function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Market Reader"
    >
      <defs>
        <linearGradient id="mrNeon" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00F5D4" />
          <stop offset="1" stopColor="#7BFF00" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="10" stroke="url(#mrNeon)" strokeWidth="2" fill="#05080f" />
      <path
        d="M16 44V20h8l8 16 8-16h8v24h-7V30l-7.5 14h-3L23 30v14H16z"
        fill="url(#mrNeon)"
      />
      <circle cx="50" cy="14" r="3" fill="#7BFF00" />
    </svg>
  );
}
