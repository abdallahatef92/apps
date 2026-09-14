/** A trend line inside a KPI tile. No axes, no labels — shape only. */
export function Sparkline({ values, color = 'var(--series-1)', height = 30 }:
  { values: number[]; color?: string; height?: number }) {
  if (values.length < 2) return null;
  const W = 200, H = height, PAD = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i * W) / (values.length - 1);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const line = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none"
         style={{ display: 'block' }} aria-hidden="true">
      <polygon points={`0,${H} ${line} ${W},${H}`} fill={color} opacity={0.14} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.75}
                strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.6} fill={color} />
    </svg>
  );
}
