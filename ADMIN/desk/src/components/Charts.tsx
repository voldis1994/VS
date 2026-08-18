/** Tiny SVG sparkline / bar chart helpers — no chart library needed. */

export function EquityCurve({ values }: { values: number[] }) {
  const w = 320;
  const h = 100;
  if (!values.length) values = [0, 0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * (w - 8) + 4;
      const y = h - 8 - ((v - min) / span) * (h - 16);
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg className="chart-box" viewBox={`0 0 ${w} ${h}`} width="100%" height="120" preserveAspectRatio="none">
      <polyline fill="none" stroke="#ff2bd6" strokeWidth="2.2" points={pts} />
      <polyline
        fill="url(#eqFill)"
        stroke="none"
        points={`4,${h - 4} ${pts} ${w - 4},${h - 4}`}
        opacity="0.25"
      />
      <defs>
        <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00f0ff" />
          <stop offset="100%" stopColor="#ff2bd6" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function DailyBars({ values }: { values: number[] }) {
  const w = 320;
  const h = 100;
  if (!values.length) values = [0];
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  const barW = (w - 16) / values.length;
  return (
    <svg className="chart-box" viewBox={`0 0 ${w} ${h}`} width="100%" height="120" preserveAspectRatio="none">
      {values.map((v, i) => {
        const bh = (Math.abs(v) / max) * (h - 20);
        const x = 8 + i * barW + 2;
        const y = v >= 0 ? h / 2 - bh : h / 2;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={Math.max(barW - 4, 2)}
            height={Math.max(bh, 2)}
            fill={v >= 0 ? '#00f0ff' : '#ff2a5a'}
            opacity={0.85}
            rx={1}
          />
        );
      })}
      <line x1="4" x2={w - 4} y1={h / 2} y2={h / 2} stroke="rgba(168,85,247,0.35)" strokeWidth="1" />
    </svg>
  );
}
