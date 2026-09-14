import { useMemo } from 'react';
import type { QueryResult } from '@shared/types';
import { SEQUENTIAL, Tooltip, fmtCompact, fmtFull, sequentialColor, useTooltip } from './chrome';

interface Props {
  result: QueryResult;
  rowColumn: string;     // e.g. cost_type
  colColumn: string;     // e.g. period_key
  valueColumn: string;
  height?: number;
}

/**
 * Magnitude across two categorical axes, on a single-hue sequential ramp — one
 * hue light to dark, mirrored for the dark surface so near-zero recedes into it.
 */
export function Heatmap({ result, rowColumn, colColumn, valueColumn }: Props) {
  const { tip, show, hide } = useTooltip();

  const { rowKeys, colKeys, cells, max } = useMemo(() => {
    const rk: string[] = [], ck: string[] = [];
    const map = new Map<string, number>();
    let mx = 0;
    for (const r of result.rows) {
      const a = String(r[rowColumn] ?? '—');
      const b = String(r[colColumn] ?? '—');
      const v = Number(r[valueColumn] ?? 0);
      if (!rk.includes(a)) rk.push(a);
      if (!ck.includes(b)) ck.push(b);
      map.set(`${a}|${b}`, v);
      mx = Math.max(mx, Math.abs(v));
    }
    ck.sort();
    return { rowKeys: rk, colKeys: ck, cells: map, max: mx || 1 };
  }, [result, rowColumn, colColumn, valueColumn]);

  if (rowKeys.length === 0) return <div className="empty">No data to plot.</div>;

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gap: 2, minWidth: 520,
                      gridTemplateColumns: `140px repeat(${colKeys.length}, minmax(46px, 1fr))` }}>
          <div />
          {colKeys.map((c) => (
            <div key={c} className="faint" style={{ fontSize: 10, textAlign: 'center', paddingBottom: 4 }}>
              {c.length > 7 ? c.slice(2) : c}
            </div>
          ))}

          {rowKeys.map((rk) => (
            <div key={rk} style={{ display: 'contents' }}>
              <div className="faint nowrap" style={{ fontSize: 11.5, paddingRight: 8,
                     overflow: 'hidden', textOverflow: 'ellipsis', alignSelf: 'center' }} title={rk}>
                {rk}
              </div>
              {colKeys.map((ck) => {
                const v = cells.get(`${rk}|${ck}`);
                const has = v !== undefined && v !== 0;
                return (
                  <div key={ck}
                       onMouseMove={(e) => show(e.clientX, e.clientY, `${rk} · ${ck}`,
                         [{ label: valueColumn.replace(/_/g, ' '), value: has ? fmtFull(v!) : 'no spend' }])}
                       onMouseLeave={hide}
                       style={{
                         height: 30, borderRadius: 4,
                         background: has ? sequentialColor(Math.abs(v!) / max) : 'var(--surface-2)',
                         display: 'grid', placeItems: 'center', fontSize: 10,
                         fontFamily: 'var(--mono)',
                         // Dark ink only on the brightest cells; light ink everywhere
                         // else. Muted grey on a mid-blue fill reads as neither.
                         color: !has ? 'var(--text-3)'
                           : Math.abs(v!) / max > 0.7 ? '#08121f' : '#eef3f8',
                       }}>
                    {has ? fmtCompact(v!) : ''}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="legend" style={{ alignItems: 'center' }}>
        <span className="faint" style={{ fontSize: 11 }}>low</span>
        <div style={{ display: 'flex', gap: 2 }}>
          {SEQUENTIAL.filter((_, i) => i % 2 === 0).map((c) => (
            <span key={c} style={{ width: 20, height: 10, borderRadius: 2, background: c }} />
          ))}
        </div>
        <span className="faint" style={{ fontSize: 11 }}>high · {fmtCompact(max)}</span>
      </div>
      <Tooltip tip={tip} />
    </>
  );
}
