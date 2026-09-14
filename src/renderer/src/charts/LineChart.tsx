import { useMemo, useRef, useState } from 'react';
import type { QueryResult } from '@shared/types';
import { ChartFrame, Legend, SERIES, Tooltip, fmtCompact, fmtFull, niceScale, useTooltip } from './chrome';

interface Props {
  result: QueryResult;
  xColumn: string;
  series: { column: string; label: string }[];
  height?: number;
  /** Fill under the first series — reads as a volume rather than a rate. */
  area?: boolean;
  /**
   * A per-period measure drawn as columns in a panel of its own beneath the
   * lines, sharing the x axis and the crosshair.
   *
   * It gets its own panel rather than its own y axis on purpose. Monthly spend
   * and a cumulative total differ by more than an order of magnitude, so on one
   * scale the columns vanish, and a second y axis on the same plot is the classic
   * way to make two series look related when the relationship is an artefact of
   * two arbitrary scales. Stacked panels keep both readable and honest.
   */
  bars?: { column: string; label: string; seriesIndex?: number };
}

/** Time series with a crosshair and a tooltip covering every series at that x. */
export function LineChart({ result, xColumn, series, height = 280, area = false, bars }: Props) {
  const rows = result.rows;
  const { tip, show, hide } = useTooltip();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const W = 1000, PAD_L = 66, PAD_R = 18, PAD_T = 14, PAD_B = 34;
  const H = height;

  // Two stacked plots when there are columns: lines above, columns below. The gap
  // has to clear the lower panel's own top tick label, or its axis reads as part
  // of the chart above it.
  const GAP = 44;
  const barBottom = H - PAD_B;
  const barTop = bars ? barBottom - Math.max(56, (H - PAD_T - PAD_B) * 0.3) : barBottom;
  const lineBottom = bars ? barTop - GAP : barBottom;

  const scale = useMemo(() => {
    const values = series.flatMap((s) => rows.map((r) => Number(r[s.column] ?? 0)));
    return niceScale(Math.min(0, ...values), Math.max(0, ...values));
  }, [rows, series]);

  const barScale = useMemo(() => {
    if (!bars) return null;
    const values = rows.map((r) => Number(r[bars.column] ?? 0));
    return niceScale(Math.min(0, ...values), Math.max(0, ...values), 2);
  }, [rows, bars]);

  if (rows.length === 0) return <div className="empty">No data to plot.</div>;

  const x = (i: number) => PAD_L + (i * (W - PAD_L - PAD_R)) / Math.max(1, rows.length - 1);
  const y = (v: number) =>
    lineBottom - ((v - scale.lo) / (scale.hi - scale.lo || 1)) * (lineBottom - PAD_T);
  const by = (v: number) => !barScale ? barBottom
    : barBottom - ((v - barScale.lo) / (barScale.hi - barScale.lo || 1)) * (barBottom - barTop);
  const barWidth = Math.min(30, ((W - PAD_L - PAD_R) / Math.max(1, rows.length)) * 0.6);
  const barColor = SERIES[(bars?.seriesIndex ?? 1) % SERIES.length];
  const labelEvery = Math.ceil(rows.length / 12);

  const onMove = (e: React.MouseEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD_L) / (W - PAD_L - PAD_R)) * (rows.length - 1));
    const idx = Math.max(0, Math.min(rows.length - 1, i));
    setHoverIndex(idx);
    show(e.clientX, e.clientY, String(rows[idx][xColumn] ?? ''), [
      ...(bars ? [{ label: bars.label, color: barColor,
                    value: fmtFull(Number(rows[idx][bars.column] ?? 0)) }] : []),
      ...series.map((s, si) => ({
        label: s.label, color: SERIES[si % SERIES.length],
        value: fmtFull(Number(rows[idx][s.column] ?? 0)),
      })),
    ]);
  };

  return (
    <>
      <ChartFrame height={height}>
        <div ref={box} style={{ width: '100%', height: '100%' }}
             onMouseMove={onMove} onMouseLeave={() => { setHoverIndex(null); hide(); }}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" role="img">
            <defs>
              <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {scale.ticks.map((v) => (
              <g key={v}>
                <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="chart-grid" strokeWidth={1} />
                <text x={PAD_L - 10} y={y(v) + 4} textAnchor="end" className="chart-tip">{fmtCompact(v)}</text>
              </g>
            ))}

            {bars && barScale && (
              <>
                {barScale.ticks.map((v) => (
                  <g key={`b${v}`}>
                    <line x1={PAD_L} x2={W - PAD_R} y1={by(v)} y2={by(v)}
                          className="chart-grid" strokeWidth={1} />
                    <text x={PAD_L - 10} y={by(v) + 4} textAnchor="end" className="chart-tip">
                      {fmtCompact(v)}
                    </text>
                  </g>
                ))}
                {/* The lower panel is a separate plot on its own scale — say so. */}
                <text x={PAD_L} y={barTop - 18} className="chart-tip" fontWeight={600}>
                  {bars.label}
                </text>
                {rows.map((r, i) => {
                  const v = Number(r[bars.column] ?? 0);
                  const top = Math.min(by(v), by(0));
                  const h = Math.abs(by(v) - by(0));
                  return (
                    <rect key={i} x={x(i) - barWidth / 2} y={top} width={barWidth}
                          height={Math.max(1, h)} rx={3} fill={barColor}
                          opacity={hoverIndex === null || hoverIndex === i ? 0.95 : 0.45} />
                  );
                })}
              </>
            )}

            {rows.map((r, i) => (i % labelEvery === 0 ? (
              <text key={i} x={x(i)} y={H - 11} textAnchor="middle" className="chart-tip">
                {String(r[xColumn] ?? '')}
              </text>
            ) : null))}

            {hoverIndex !== null && (
              <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={PAD_T} y2={barBottom}
                    stroke="var(--accent-line)" strokeWidth={1} />
            )}

            {area && (
              <path fill="url(#areaFill)" d={
                `M ${x(0)} ${y(scale.lo)} ` +
                rows.map((r, i) => `L ${x(i)} ${y(Number(r[series[0].column] ?? 0))}`).join(' ') +
                ` L ${x(rows.length - 1)} ${y(scale.lo)} Z`} />
            )}

            {series.map((s, si) => (
              <polyline key={s.column} fill="none" stroke={SERIES[si % SERIES.length]}
                        strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
                        points={rows.map((r, i) => `${x(i)},${y(Number(r[s.column] ?? 0))}`).join(' ')} />
            ))}

            {hoverIndex !== null && series.map((s, si) => (
              <circle key={s.column} cx={x(hoverIndex)} cy={y(Number(rows[hoverIndex][s.column] ?? 0))}
                      r={4.5} fill={SERIES[si % SERIES.length]} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </svg>
        </div>
      </ChartFrame>
      <Legend items={series.map((s, i) => ({ label: s.label, color: SERIES[i % SERIES.length] }))} />
      <Tooltip tip={tip} />
    </>
  );
}
