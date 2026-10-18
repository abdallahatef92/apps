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

/**
 * Single-hue sequential ramp, 7 steps low → high, from the active theme's
 * `--seq-n` tokens (styles.css): on a dark theme high is brightest and low
 * recedes into the surface; on a light theme high is darkest.
 */
export const SEQUENTIAL = [1, 2, 3, 4, 5, 6, 7].map((n) => `var(--seq-${n})`);
/** Cell ink matching each SEQUENTIAL step (`--seq-ink-n`), flipped per theme. */
export const SEQUENTIAL_INK = [1, 2, 3, 4, 5, 6, 7].map((n) => `var(--seq-ink-${n})`);

function sequentialIndex(t: number): number {
  return Math.min(SEQUENTIAL.length - 1, Math.max(0, Math.round(t * (SEQUENTIAL.length - 1))));
}

export function sequentialColor(t: number): string {
  if (!Number.isFinite(t)) return 'var(--div-mid)';
  return SEQUENTIAL[sequentialIndex(t)];
}

/** Readable text ink on the fill `sequentialColor(t)` returns. */
export function sequentialInk(t: number): string {
  if (!Number.isFinite(t)) return 'var(--text-3)';
  return SEQUENTIAL_INK[sequentialIndex(t)];
}

/** Diverging step for a value: 0 = midpoint, -1..-4 negative arm, 1..4 positive arm. */
function divergingStep(value: number, extent: number): number {
  if (!extent || !Number.isFinite(value)) return 0;
  const t = Math.max(-1, Math.min(1, value / extent));
  const mag = Math.abs(t);
  if (mag < 0.06) return 0;
  const n = Math.min(3, Math.floor(mag * 4)) + 1;   // 1 = faintest, nearest the midpoint
  return t < 0 ? -n : n;
}

/**
 * Diverging orange↔blue with a neutral midpoint, for signed variance: orange is
 * over budget, blue under — never red/green. Each arm passes the dataviz
 * validator's ordinal checks against --surface (faintest step >= 2:1). The
 * steps are the theme's `--div-neg-n` / `--div-pos-n` tokens.
 */
export function divergingColor(value: number, extent: number): string {
  const s = divergingStep(value, extent);
  if (s === 0) return 'var(--div-mid)';
  return s < 0 ? `var(--div-neg-${-s})` : `var(--div-pos-${s})`;
}

/** Readable label ink on the fill `divergingColor(value, extent)` returns. */
export function divergingInk(value: number, extent: number): string {
  const s = divergingStep(value, extent);
  return s === 0 ? 'var(--div-ink-mid)' : `var(--div-ink-${Math.abs(s)})`;
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
