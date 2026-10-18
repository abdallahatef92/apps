import { useMemo } from 'react';
import type { QueryResult } from '@shared/types';
import { SEQUENTIAL, Tooltip, fmtCompact, fmtFull, sequentialColor, sequentialInk, useTooltip } from './chrome';

interface Props {
  result: QueryResult;
  rowColumn: string;     // e.g. cost_type
  colColumn: string;     // e.g. period_key
  valueColumn: string;
  height?: number;
  /** Numeric sort keys, so rows/columns keep the query's order instead of sorting as text. */
  rowOrderColumn?: string;
  colOrderColumn?: string;
  /** Columns / rows shown as plain figures: not shaded and left out of the colour scale
   *  (an opening balance, a To date column, an "All" row). */
  plainCols?: string[];
  plainRows?: string[];
}

/**
 * Magnitude across two categorical axes, on a single-hue sequential ramp — one
 * hue, ordered by the theme so near-zero recedes into its surface (dark low on a
 * dark theme, light low on a light one).
 */
export function Heatmap({ result, rowColumn, colColumn, valueColumn, rowOrderColumn, colOrderColumn, plainCols = [], plainRows = [] }: Props) {
  const { tip, show, hide } = useTooltip();

  const { rowKeys, colKeys, cells, max } = useMemo(() => {
    const rk: string[] = [], ck: string[] = [];
    const map = new Map<string, number>();
    const rOrd = new Map<string, number>(), cOrd = new Map<string, number>();
    let mx = 0;
    for (const r of result.rows) {
      const a = String(r[rowColumn] ?? '—');
      const b = String(r[colColumn] ?? '—');
      const v = Number(r[valueColumn] ?? 0);
      if (!rk.includes(a)) rk.push(a);
      if (!ck.includes(b)) ck.push(b);
      map.set(`${a}|${b}`, v);
      if (rowOrderColumn) rOrd.set(a, Number(r[rowOrderColumn] ?? 0));
      if (colOrderColumn) cOrd.set(b, Number(r[colOrderColumn] ?? 0));
      if (!plainCols.includes(b) && !plainRows.includes(a)) mx = Math.max(mx, Math.abs(v));
    }
    if (colOrderColumn) ck.sort((x, y) => (cOrd.get(x) ?? 0) - (cOrd.get(y) ?? 0)); else ck.sort();
    if (rowOrderColumn) rk.sort((x, y) => (rOrd.get(x) ?? 0) - (rOrd.get(y) ?? 0));
    return { rowKeys: rk, colKeys: ck, cells: map, max: mx || 1 };
  }, [result, rowColumn, colColumn, valueColumn, rowOrderColumn, colOrderColumn, plainCols, plainRows]);

  if (rowKeys.length === 0) return <div className="empty">No data to plot.</div>;

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gap: 2, minWidth: 520,
                      gridTemplateColumns: `${rowOrderColumn ? 200 : 140}px repeat(${colKeys.length}, minmax(46px, 1fr))` }}>
          <div style={{ position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }} />
          {colKeys.map((c) => (
            <div key={c} className="faint" style={{ fontSize: 10, textAlign: 'center', paddingBottom: 4 }}>
              {/^\d{4}-/.test(c) && c.length > 7 ? c.slice(2) : c}
            </div>
          ))}

          {rowKeys.map((rk) => (
            <div key={rk} style={{ display: 'contents' }}>
              <div className="faint nowrap" style={{ fontSize: 11.5, paddingRight: 8,
                     overflow: 'hidden', textOverflow: 'ellipsis', alignSelf: 'center',
                     position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1,
                     fontWeight: plainRows.includes(rk) ? 700 : undefined }} title={rk}>
                {rk}
              </div>
              {colKeys.map((ck) => {
                const v = cells.get(`${rk}|${ck}`);
                const has = v !== undefined && v !== 0;
                const plain = plainCols.includes(ck) || plainRows.includes(rk);
                return (
                  <div key={ck}
                       onMouseMove={(e) => show(e.clientX, e.clientY, `${rk} · ${ck}`,
                         [{ label: valueColumn.replace(/_/g, ' '), value: has ? fmtFull(v!) : 'no spend' }])}
                       onMouseLeave={hide}
                       style={{
                         height: 30, borderRadius: 4,
                         background: has && !plain ? sequentialColor(Math.abs(v!) / max) : 'var(--surface-2)',
                         display: 'grid', placeItems: 'center', fontSize: 10,
                         fontFamily: 'var(--mono)',
                         // Ink is chosen per ramp step by the theme (--seq-ink-n):
                         // dark ink on the brightest steps of a dark theme, white on
                         // the darkest steps of a light one. Muted grey on a mid-blue
                         // fill reads as neither.
                         color: !has ? 'var(--text-3)' : plain ? 'var(--text-2)' : sequentialInk(Math.abs(v!) / max),
                         fontWeight: plain ? 700 : undefined,
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
          {SEQUENTIAL.map((c) => (
            <span key={c} style={{ width: 20, height: 10, borderRadius: 2, background: c }} />
          ))}
        </div>
        <span className="faint" style={{ fontSize: 11 }}>high · {fmtCompact(max)}</span>
      </div>
      <Tooltip tip={tip} />
    </>
  );
}
