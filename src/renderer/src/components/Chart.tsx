/**
 * Small dependency-free SVG charts. They read a QueryResult directly, so the
 * shape of a chart is decided by the SQL, not by client-side maths.
 */
import type { QueryResult } from '@shared/types';
import { money } from '../lib/format';

const SERIES_COLORS = ['#3d8bfd', '#2fb67c', '#e0a53a', '#b07de0', '#e2565f'];

interface LineProps {
  result: QueryResult;
  xColumn: string;
  series: { column: string; label: string }[];
  height?: number;
}

export function LineChart({ result, xColumn, series, height = 260 }: LineProps) {
  const rows = result.rows;
  if (rows.length === 0) return <div className="empty">No data to plot.</div>;

  const W = 900, H = height, PAD_L = 64, PAD_R = 16, PAD_T = 14, PAD_B = 34;
  const values = series.flatMap((s) => rows.map((r) => Number(r[s.column] ?? 0)));
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const x = (i: number) => PAD_L + (i * (W - PAD_L - PAD_R)) / Math.max(1, rows.length - 1);
  const y = (v: number) => H - PAD_B - ((v - min) / (max - min || 1)) * (H - PAD_T - PAD_B);

  const ticks = 4;
  const labelEvery = Math.ceil(rows.length / 12);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} role="img">
        {Array.from({ length: ticks + 1 }, (_, t) => {
          const v = min + ((max - min) * t) / ticks;
          return (
            <g key={t}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="#223140" strokeWidth={1} />
              <text x={PAD_L - 8} y={y(v) + 4} textAnchor="end" className="chart-tip">{money(v)}</text>
            </g>
          );
        })}
        {rows.map((r, i) =>
          i % labelEvery === 0 ? (
            <text key={i} x={x(i)} y={H - 12} textAnchor="middle" className="chart-tip">
              {String(r[xColumn] ?? '')}
            </text>
          ) : null,
        )}
        {series.map((s, si) => (
          <polyline
            key={s.column}
            fill="none"
            stroke={SERIES_COLORS[si % SERIES_COLORS.length]}
            strokeWidth={2}
            strokeLinejoin="round"
            points={rows.map((r, i) => `${x(i)},${y(Number(r[s.column] ?? 0))}`).join(' ')}
          />
        ))}
      </svg>
      <div className="row" style={{ gap: 16, marginTop: 6 }}>
        {series.map((s, si) => (
          <span key={s.column} className="faint" style={{ fontSize: 12 }}>
            <span style={{
              display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 6,
              background: SERIES_COLORS[si % SERIES_COLORS.length],
            }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

interface BarProps {
  result: QueryResult;
  labelColumn: string;
  valueColumn: string;
  limit?: number;
}

export function BarChart({ result, labelColumn, valueColumn, limit = 12 }: BarProps) {
  const rows = result.rows.slice(0, limit);
  if (rows.length === 0) return <div className="empty">No data to plot.</div>;
  const max = Math.max(...rows.map((r) => Math.abs(Number(r[valueColumn] ?? 0))), 1);

  return (
    <div style={{ display: 'grid', gap: 7 }}>
      {rows.map((r, i) => {
        const v = Number(r[valueColumn] ?? 0);
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '190px 1fr 96px', gap: 10, alignItems: 'center' }}>
            <span className="faint nowrap" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={String(r[labelColumn] ?? '')}>
              {String(r[labelColumn] ?? '—')}
            </span>
            <div style={{ background: '#1b2733', borderRadius: 3, height: 16, overflow: 'hidden' }}>
              <div style={{
                width: `${(Math.abs(v) / max) * 100}%`, height: '100%',
                background: v < 0 ? '#e2565f' : SERIES_COLORS[0], borderRadius: 3,
              }} />
            </div>
            <span className="mono right">{money(v)}</span>
          </div>
        );
      })}
    </div>
  );
}
