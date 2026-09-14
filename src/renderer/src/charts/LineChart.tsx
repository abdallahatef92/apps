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
}

/** Time series with a crosshair and a tooltip covering every series at that x. */
export function LineChart({ result, xColumn, series, height = 280, area = false }: Props) {
  const rows = result.rows;
  const { tip, show, hide } = useTooltip();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const W = 1000, PAD_L = 66, PAD_R = 18, PAD_T = 14, PAD_B = 34;
  const H = height;

  const scale = useMemo(() => {
    const values = series.flatMap((s) => rows.map((r) => Number(r[s.column] ?? 0)));
    return niceScale(Math.min(0, ...values), Math.max(0, ...values));
  }, [rows, series]);

  if (rows.length === 0) return <div className="empty">No data to plot.</div>;

  const x = (i: number) => PAD_L + (i * (W - PAD_L - PAD_R)) / Math.max(1, rows.length - 1);
  const y = (v: number) => H - PAD_B - ((v - scale.lo) / (scale.hi - scale.lo || 1)) * (H - PAD_T - PAD_B);
  const labelEvery = Math.ceil(rows.length / 12);

  const onMove = (e: React.MouseEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD_L) / (W - PAD_L - PAD_R)) * (rows.length - 1));
    const idx = Math.max(0, Math.min(rows.length - 1, i));
    setHoverIndex(idx);
    show(e.clientX, e.clientY, String(rows[idx][xColumn] ?? ''),
      series.map((s, si) => ({
        label: s.label, color: SERIES[si % SERIES.length],
        value: fmtFull(Number(rows[idx][s.column] ?? 0)),
      })));
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

            {rows.map((r, i) => (i % labelEvery === 0 ? (
              <text key={i} x={x(i)} y={H - 11} textAnchor="middle" className="chart-tip">
                {String(r[xColumn] ?? '')}
              </text>
            ) : null))}

            {hoverIndex !== null && (
              <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={PAD_T} y2={H - PAD_B}
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
