import { useMemo, useRef, useState } from 'react';
import type { QueryResult } from '@shared/types';
import { ChartFrame, Legend, SERIES, Tooltip, fmtCompact, fmtFull, niceScale, useTooltip } from './chrome';

interface Props {
  /** Long format, already aggregated in SQL: one row per x × series. */
  result: QueryResult;
  xColumn: string;
  valueColumn: string;
  /** Omit for a single series. */
  seriesColumn?: string;
  /** Fixes each series' colour slot, so a filter never repaints the survivors. */
  orderColumn?: string;
  /** A series with this name is an aggregate of the rest, drawn in a neutral, not a series colour. */
  otherLabel?: string;
  height?: number;
  valueLabel?: string;
}

const NEUTRAL = 'var(--text-3)';

/**
 * Vertical columns over an ordered x (months), stacked by series. Positive
 * parts stack up from zero and negative parts (a month whose adjustments
 * outweigh its work) stack down, so a negative never hides inside a positive.
 * Segments are separated by a 2px surface gap.
 */
export function StackedColumnChart({
  result, xColumn, valueColumn, seriesColumn, orderColumn, otherLabel, height = 280, valueLabel,
}: Props) {
  const { tip, show, hide } = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const { xs, series, cells } = useMemo(() => {
    const xs: string[] = [];
    const order = new Map<string, number>();
    const cells = new Map<string, number>();
    for (const r of result.rows) {
      const x = String(r[xColumn] ?? '');
      const s = seriesColumn ? String(r[seriesColumn] ?? '') : (valueLabel ?? valueColumn);
      if (!xs.includes(x)) xs.push(x);
      if (!order.has(s)) order.set(s, orderColumn ? Number(r[orderColumn] ?? order.size) : order.size);
      cells.set(`${x}\u0001${s}`, Number(r[valueColumn] ?? 0));
    }
    xs.sort();
    const series = [...order.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s);
    return { xs, series, cells };
  }, [result, xColumn, valueColumn, seriesColumn, orderColumn, valueLabel]);

  const color = (s: string, i: number) => (s === otherLabel ? NEUTRAL : SERIES[i % SERIES.length]);

  const scale = useMemo(() => {
    let lo = 0, hi = 0;
    for (const x of xs) {
      let pos = 0, neg = 0;
      for (const s of series) {
        const v = cells.get(`${x}\u0001${s}`) ?? 0;
        if (v >= 0) pos += v; else neg += v;
      }
      hi = Math.max(hi, pos); lo = Math.min(lo, neg);
    }
    return niceScale(lo, hi);
  }, [xs, series, cells]);

  if (xs.length === 0) return <div className="empty">No data to plot.</div>;

  const W = 1000, PAD_L = 66, PAD_R = 18, PAD_T = 14, PAD_B = 34, H = height;
  const y = (v: number) => (H - PAD_B) - ((v - scale.lo) / (scale.hi - scale.lo || 1)) * (H - PAD_B - PAD_T);
  const band = (W - PAD_L - PAD_R) / xs.length;
  const colW = Math.min(46, band * 0.62);
  const cx = (i: number) => PAD_L + band * i + band / 2;
  const labelEvery = Math.ceil(xs.length / 14);

  const onMove = (e: React.MouseEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(xs.length - 1, Math.floor((px - PAD_L) / band)));
    setHover(i);
    const x = xs[i];
    const parts = series
      .map((s, si) => ({ s, si, v: cells.get(`${x}\u0001${s}`) ?? 0 }))
      .filter((p) => p.v !== 0);
    const total = parts.reduce((a, p) => a + p.v, 0);
    show(e.clientX, e.clientY, x, [
      ...parts.map((p) => ({ label: p.s, value: fmtFull(p.v), color: color(p.s, p.si) })),
      ...(series.length > 1 ? [{ label: 'Total', value: fmtFull(total) }] : []),
    ]);
  };

  return (
    <>
      <ChartFrame height={height}>
        <div ref={box} style={{ width: '100%', height: '100%' }}
             onMouseMove={onMove} onMouseLeave={() => { setHover(null); hide(); }}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" role="img"
               aria-label={`Columns of ${valueLabel ?? valueColumn} by ${xColumn}`}>
            {scale.ticks.map((v) => (
              <g key={v}>
                <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="chart-grid" strokeWidth={1} />
                <text x={PAD_L - 10} y={y(v) + 4} textAnchor="end" className="chart-tip">{fmtCompact(v)}</text>
              </g>
            ))}
            {xs.map((x, i) => {
              let up = 0, down = 0;
              return (
                <g key={x} opacity={hover === null || hover === i ? 1 : 0.5}>
                  {series.map((s, si) => {
                    const v = cells.get(`${x}\u0001${s}`) ?? 0;
                    if (v === 0) return null;
                    const from = v > 0 ? up : down;
                    const to = from + v;
                    if (v > 0) up = to; else down = to;
                    const top = Math.min(y(from), y(to));
                    const h = Math.abs(y(from) - y(to));
                    return (
                      <rect key={s} x={cx(i) - colW / 2} y={top} width={colW} height={Math.max(1, h)}
                            fill={color(s, si)} stroke="var(--surface)" strokeWidth={2} rx={2} />
                    );
                  })}
                </g>
              );
            })}
            <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} stroke="var(--axis)" strokeWidth={1} />
            {xs.map((x, i) => (i % labelEvery === 0 ? (
              <text key={x} x={cx(i)} y={H - 11} textAnchor="middle" className="chart-tip">{x}</text>
            ) : null))}
          </svg>
        </div>
      </ChartFrame>
      <Legend items={series.map((s, i) => ({ label: s, color: color(s, i) }))} />
      <Tooltip tip={tip} />
    </>
  );
}
