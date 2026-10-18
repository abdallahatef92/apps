import { Fragment, useMemo, useState } from 'react';
import type { QueryResult } from '@shared/types';
import { formatCell } from '../lib/format';

export interface PivotMeasure {
  /** Shown on the toggle; also the name `formatCell` uses to pick the number format. */
  key: string;
  label: string;
  /** The result column holding this measure. Omit for a ratio. */
  column?: string;
  /** A derived measure: numerator column / denominator column, taken from the numbers the query returned. */
  ratio?: [string, string];
  /** Leave group subtotals and the grand total blank (a quantity across rows with different units). */
  noGroupTotals?: boolean;
}

interface Props {
  /** Long format, already aggregated in SQL: one row per row key × period. */
  result: QueryResult;
  /** Leading columns shown for every pivot row (the first one can also group). */
  rowColumns: string[];
  /** Columns that, besides rowColumns, identify a pivot row (e.g. a hidden drill-down key). */
  keyColumns?: string[];
  colColumn: string;
  colOrderColumn: string;
  measures: PivotMeasure[];
  /** Group the rows by this row column, with collapsible subtotals. */
  groupColumn?: string;
  /** Periods listed but left out of the To date column (Pending). */
  excludeFromTotal?: string[];
  totalLabel?: string;
  columnLabels?: Record<string, string>;
  onRowClick?: (row: Record<string, unknown>) => void;
  selectedKey?: string | null;
  maxHeight?: number;
  /** Put the To date column right after the row columns, so it is visible without scrolling the months. */
  totalFirst?: boolean;
  /** A colour per group (a CSS colour / token), drawn as the group row's edge and tint and on its rows. */
  groupColor?: (groupKey: string) => string | undefined;
  /** A period column to tint (the report / cut-off month). */
  highlightPeriod?: string | null;
  /** Open with every group collapsed to its subtotal row (a long register reads as categories first). */
  startCollapsed?: boolean;
}

type Cell = Record<string, number>;

/**
 * Rows × periods from a long-format result (what the Service per Month / PO per Month sheets are), with a
 * measure toggle (amount / qty / rate), a To date column, collapsible group subtotals and a grand total.
 * Every figure is a number the query returned; the page only lays them out, sums them for the subtotal
 * rows (the same on-screen rollup DataTable does) and divides amount by qty for the rate view.
 */
export function MonthPivot({
  result, rowColumns, keyColumns = [], colColumn, colOrderColumn, measures, groupColumn, excludeFromTotal = [],
  totalLabel = 'To date', columnLabels, onRowClick, selectedKey, maxHeight = 560, totalFirst = false,
  highlightPeriod = null, startCollapsed = false, groupColor,
}: Props) {
  const [measureKey, setMeasureKey] = useState(measures[0]?.key ?? '');
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const allClosed = startCollapsed;   // until a group is toggled, startCollapsed decides whether it is open
  const measure = measures.find((m) => m.key === measureKey) ?? measures[0];
  const label = (c: string) => columnLabels?.[c] ?? c.replace(/_/g, ' ');

  const valueColumns = useMemo(() => {
    const cols = new Set<string>();
    for (const m of measures) {
      if (m.column) cols.add(m.column);
      if (m.ratio) { cols.add(m.ratio[0]); cols.add(m.ratio[1]); }
    }
    return [...cols];
  }, [measures]);

  const { periods, rows } = useMemo(() => {
    const order = new Map<string, number>();
    const byKey = new Map<string, { key: string; first: Record<string, unknown>; cells: Map<string, Cell> }>();
    const idCols = [...rowColumns, ...keyColumns];
    for (const r of result.rows) {
      const p = String(r[colColumn] ?? '');
      if (!order.has(p)) order.set(p, Number(r[colOrderColumn] ?? 0));
      const key = idCols.map((c) => String(r[c] ?? '')).join('\u0001');
      let row = byKey.get(key);
      if (!row) { row = { key, first: r, cells: new Map() }; byKey.set(key, row); }
      const cell: Cell = {};
      for (const c of valueColumns) cell[c] = Number(r[c] ?? 0);
      row.cells.set(p, cell);
    }
    return { periods: [...order.entries()].sort((a, b) => a[1] - b[1]).map(([p]) => p), rows: [...byKey.values()] };
  }, [result, rowColumns, keyColumns, colColumn, colOrderColumn, valueColumns]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return rows;
    return rows.filter((r) => rowColumns.some((c) => String(r.first[c] ?? '').toLowerCase().includes(f)));
  }, [rows, filter, rowColumns]);

  const add = (into: Cell, from: Cell) => { for (const c of valueColumns) into[c] = (into[c] ?? 0) + (from[c] ?? 0); };
  const rollup = (list: typeof rows) => {
    const byPeriod = new Map<string, Cell>();
    const total: Cell = {};
    for (const r of list) {
      for (const [p, cell] of r.cells) {
        const t = byPeriod.get(p) ?? {};
        add(t, cell); byPeriod.set(p, t);
        if (!excludeFromTotal.includes(p)) add(total, cell);
      }
    }
    return { byPeriod, total };
  };
  const rowTotal = (r: (typeof rows)[number]) => rollup([r]).total;

  const groups = useMemo(() => {
    if (!groupColumn) return null;
    const map = new Map<string, typeof shown>();
    for (const r of shown) {
      const k = String(r.first[groupColumn] ?? '—');
      const list = map.get(k);
      if (list) list.push(r); else map.set(k, [r]);
    }
    return [...map.entries()].map(([key, list]) => ({ key, rows: list, ...rollup(list) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, groupColumn, excludeFromTotal.join()]);

  const grand = useMemo(() => rollup(shown),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, excludeFromTotal.join()]);

  const value = (cell: Cell | undefined): number | null => {
    if (!cell || !measure) return null;
    if (measure.ratio) {
      const den = cell[measure.ratio[1]] ?? 0;
      return Math.abs(den) > 1e-9 ? (cell[measure.ratio[0]] ?? 0) / den : null;
    }
    const v = cell[measure.column ?? ''];
    return v === undefined ? null : v;
  };
  const fmt = (v: number | null) => (v === null ? '' : formatCell(measure?.key ?? 'amount', v));
  const hl = (p: string) => (p === highlightPeriod ? { background: 'var(--accent-soft)' } : undefined);

  if (rows.length === 0) return <div className="empty">No rows.</div>;
  const span = rowColumns.length + periods.length + 1;

  const dataRow = (r: (typeof rows)[number]) => {
    const cells = r.cells;
    const color = groupColumn && groupColor ? groupColor(String(r.first[groupColumn] ?? '—')) : undefined;
    const tot = <td key="__tot" className="num" style={{ fontWeight: 600 }}>{fmt(value(rowTotal(r)))}</td>;
    return (
    <tr key={r.key} className={selectedKey === r.key ? 'rpt-sel' : undefined}
        style={onRowClick ? { cursor: 'pointer' } : undefined}
        onClick={onRowClick ? () => onRowClick(r.first) : undefined}>
      {rowColumns.map((c, i) => (
        <td key={c} className={i === 0 ? 'sticky-col' : undefined}
            style={i === 0 && color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}>
          {c === groupColumn ? '' : String(r.first[c] ?? '')}
        </td>
      ))}
      {totalFirst && tot}
      {periods.map((p) => <td key={p} className="num" style={hl(p)}>{fmt(value(cells.get(p)))}</td>)}
      {!totalFirst && tot}
    </tr>
    );
  };

  const sumRow = (key: string, title: string, sums: ReturnType<typeof rollup>, strong: boolean, onClick?: () => void, open?: boolean,
                  color?: string) => {
    const byPeriod = sums.byPeriod;
    const blank = measure?.noGroupTotals;
    const tint = color ? { background: `color-mix(in srgb, ${color} 14%, transparent)` } : {};
    const tot = <td key="__tot" className="num" style={{ fontWeight: 700, ...tint }}>{blank ? '' : fmt(value(sums.total))}</td>;
    return (
    <tr key={key} className="group-row" style={{ cursor: onClick ? 'pointer' : undefined, ...(strong ? { borderTop: '2px solid var(--border)' } : {}) }}
        onClick={onClick}>
      <td className="sticky-col" colSpan={Math.max(1, rowColumns.length)}
          style={{ ...(strong ? { fontWeight: 700 } : {}), ...tint, ...(color ? { boxShadow: `inset 4px 0 0 ${color}` } : {}) }}>
        {onClick && <span style={{ marginRight: 6 }}>{open ? '▾' : '▸'}</span>}
        {color && <span className="pivot-swatch" style={{ background: color }} />}{title}
      </td>
      {totalFirst && tot}
      {periods.map((p) => <td key={p} className="num" style={{ fontWeight: 600, ...tint, ...hl(p) }}>{blank ? '' : fmt(value(byPeriod.get(p)))}</td>)}
      {!totalFirst && tot}
    </tr>
    );
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        {measures.length > 1 && (
          <div className="segmented">
            {measures.map((m) => (
              <button key={m.key} className={m.key === measure?.key ? 'on' : ''} onClick={() => setMeasureKey(m.key)}>{m.label}</button>
            ))}
          </div>
        )}
        <input placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
        <div className="spacer" />
        <span className="faint" style={{ fontSize: 12 }}>
          {shown.length.toLocaleString()} of {rows.length.toLocaleString()} rows · {periods.length} periods
        </span>
      </div>
      <div className="table-wrap dtable" style={{ maxHeight }}>
        <table>
          <thead>
            <tr>
              {rowColumns.map((c, i) => <th key={c} className={i === 0 ? 'sticky-col' : undefined}>{label(c)}</th>)}
              {totalFirst && <th className="num" style={{ background: 'var(--accent-soft)' }}>{totalLabel}</th>}
              {periods.map((p) => (
                <th key={p} className="num" title={excludeFromTotal.includes(p) ? 'Not in To date' : undefined}
                    style={{ ...(excludeFromTotal.includes(p) ? { fontStyle: 'italic' } : {}), ...hl(p) }}>{p}</th>
              ))}
              {!totalFirst && <th className="num">{totalLabel}</th>}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={span}><div className="empty">No rows match.</div></td></tr>}
            {groups
              ? groups.map((g) => {
                const open = g.key in collapsed ? !collapsed[g.key] : !allClosed;
                return (
                  <Fragment key={g.key}>
                    {sumRow(`g:${g.key}`, `${g.key} (${g.rows.length})`, g, false,
                      () => setCollapsed((s) => ({ ...s, [g.key]: open })), open, groupColor?.(g.key))}
                    {open && g.rows.map(dataRow)}
                  </Fragment>
                );
              })
              : shown.map(dataRow)}
            {shown.length > 0 && sumRow('total', 'Total', grand, true)}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The identity of a pivot row, as MonthPivot computes it, for highlighting the drilled row. */
export function pivotRowKey(row: Record<string, unknown>, columns: string[]): string {
  return columns.map((c) => String(row[c] ?? '')).join('\u0001');
}
