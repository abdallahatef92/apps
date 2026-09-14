/**
 * Shared chart chrome: scales, ticks, the tooltip layer and the legend.
 *
 * Charts here read a QueryResult straight from SQL — the shape of a chart is
 * decided by the query and its stored visualisation spec, never by re-aggregating
 * in the browser.
 */
import { useCallback, useState, type ReactNode } from 'react';

/** Categorical slots, assigned in fixed order and never cycled. */
export const SERIES = [
  'var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)',
];

/** Single-hue sequential ramp, mirrored for a dark surface: low recedes. */
export const SEQUENTIAL = ['#0d366b', '#154a8c', '#1c5cab', '#256abf', '#2a78d6',
  '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb'];

export function sequentialColor(t: number): string {
  if (!Number.isFinite(t)) return 'var(--div-mid)';
  const i = Math.min(SEQUENTIAL.length - 1, Math.max(0, Math.round(t * (SEQUENTIAL.length - 1))));
  return SEQUENTIAL[i];
}

/** Diverging blue↔red with a neutral midpoint, for signed variance. */
export function divergingColor(value: number, extent: number): string {
  if (!extent || !Number.isFinite(value)) return 'var(--div-mid)';
  const t = Math.max(-1, Math.min(1, value / extent));
  const mag = Math.abs(t);
  if (mag < 0.06) return 'var(--div-mid)';
  const arm = t < 0
    ? ['#5b3540', '#8b3a42', '#b03b3f', '#d03b3b']
    : ['#24405f', '#256abf', '#3987e5', '#6da7ec'];
  return arm[Math.min(arm.length - 1, Math.floor(mag * arm.length))];
}

export const fmtCompact = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(0)}K`;
  return `${s}${a.toFixed(0)}`;
};

export const fmtFull = (v: number): string =>
  Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';

/** "Nice" axis bounds and ticks around a value range. */
export function niceScale(min: number, max: number, count = 4):
  { lo: number; hi: number; ticks: number[] } {
  if (min === max) { min = Math.min(0, min); max = max || 1; }
  const span = max - min || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Number(t.toFixed(10)));
  return { lo, hi, ticks };
}

export interface TipRow { label: string; value: string; color?: string }

/** A floating tooltip, positioned in viewport coordinates. */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; title: string; rows: TipRow[] } | null>(null);
  const hide = useCallback(() => setTip(null), []);
  const show = useCallback((x: number, y: number, title: string, rows: TipRow[]) =>
    setTip({ x, y, title, rows }), []);
  return { tip, show, hide };
}

export function Tooltip({ tip }: { tip: { x: number; y: number; title: string; rows: TipRow[] } | null }) {
  if (!tip) return null;
  const flip = tip.x > window.innerWidth - 220;
  return (
    <div className="tooltip" style={{ left: flip ? tip.x - 200 : tip.x + 14, top: tip.y - 10 }}>
      <div className="t-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div className="t-row" key={i}>
          <span className="k">
            {r.color && <span className="legend-swatch" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="v">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;   // one series is named by the title
  return (
    <div className="legend">
      {items.map((s) => (
        <span className="legend-item" key={s.label}>
          <span className="legend-swatch" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function ChartFrame({ children, height }: { children: ReactNode; height: number }) {
  return <div style={{ position: 'relative', width: '100%', height }}>{children}</div>;
}
