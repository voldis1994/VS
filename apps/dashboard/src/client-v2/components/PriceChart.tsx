import { fmtPrice } from '../lib/format';

export function PriceChart({ prices }: { prices: number[] }) {
  const w = 400;
  const h = 180;
  const pad = 8;

  if (prices.length < 2) {
    return (
      <div className="m-chart m-chart--empty">
        <span>Waiting for live price…</span>
      </div>
    );
  }

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = Math.max(max - min, 0.01);
  const pts = prices.map((p, i) => {
    const x = pad + (i / (prices.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (p - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  });
  const last = prices[prices.length - 1]!;
  const lastY = pad + (1 - (last - min) / range) * (h - pad * 2);

  return (
    <div className="m-chart">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="m-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(62, 232, 197, 0.22)" />
            <stop offset="100%" stopColor="rgba(62, 232, 197, 0)" />
          </linearGradient>
        </defs>
        <polygon
          fill="url(#m-chart-fill)"
          points={`${pad},${h - pad} ${pts.join(' ')} ${w - pad},${h - pad}`}
        />
        <polyline fill="none" stroke="rgba(62, 232, 197, 0.85)" strokeWidth="2" points={pts.join(' ')} />
        <line
          x1={pad}
          x2={w - pad}
          y1={lastY}
          y2={lastY}
          stroke="rgba(255,255,255,0.15)"
          strokeDasharray="4 4"
        />
        <text x={w - pad - 4} y={lastY - 6} textAnchor="end" fill="#3ee8c5" fontSize="11" fontFamily="IBM Plex Mono">
          {fmtPrice(last)}
        </text>
      </svg>
    </div>
  );
}
