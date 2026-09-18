import { Fragment, useMemo, useState } from 'react';
import { formatCell, isNumericColumn, isSummableColumn } from '../lib/format';
import type { QueryResult } from '@shared/types';

const SOURCE_BADGE: Record<string, string> = { ACTUAL: 'info', SERVICE: 'mute' };

interface Props {
  result: QueryResult;
  maxHeight?: number;
  /** Colour negative values red / positive green on these columns. */
  signColumns?: string[];
  /** Render this column's value as a small badge instead of plain text. */
  badgeColumn?: string;
  /**
   * A 0/1 (or boolean) column that marks a row for attention — e.g. a PO whose
   * detail is still missing. The column itself is not shown; it only tints the
   * row and adds a small flag in the first cell.
   */
  flagColumn?: string;
  flagLabel?: string;
}

/**
 * Renders a result set exactly as SQL returned it — no client-side aggregation
 * of the underlying numbers. Sorting, the text filter, the column picker, and
 * grouping are presentation only: grouping sums rows the query already
 * returned into an on-screen subtotal, the same rollup Reports.tsx's pivot
 * already does, never a second source of truth for a number.
 */
export function DataTable({
  result, maxHeight = 520, signColumns = [], badgeColumn, flagColumn, flagLabel,
}: Props) {
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());

  const numeric = useMemo(() => {
    const first = result.rows[0] ?? {};
    return new Set(result.columns.filter((c) => isNumericColumn(c, first[c])));
  }, [result]);

  const summable = useMemo(() => {
    const first = result.rows[0] ?? {};
    return new Set(result.columns.filter((c) => isSummableColumn(c, first[c])));
  }, [result]);

  // The flag column drives row styling only; it never appears as its own cell,
  // and it makes no sense to group or hide-toggle it either.
  const displayColumns = flagColumn ? result.columns.filter((c) => c !== flagColumn) : result.columns;
  const groupCandidates = useMemo(
    () => displayColumns.filter((c) => !numeric.has(c) && c !== badgeColumn),
    [displayColumns, numeric, badgeColumn],
  );
  const visibleColumns = displayColumns.filter((c) => !hiddenCols.has(c));

  const rows = useMemo(() => {
    let out = result.rows;
    const f = filter.trim().toLowerCase();
    if (f) {
      out = out.filter((r) => result.columns.some((c) => String(r[c] ?? '').toLowerCase().includes(f)));
    }
    if (sort) {
      const { col, dir } = sort;
      out = [...out].sort((a, b) => {
        const x = a[col], y = b[col];
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x).localeCompare(String(y)) * dir;
      });
    }
    return out;
  }, [result, sort, filter]);

  const groups = useMemo(() => {
    if (!groupBy || !groupCandidates.includes(groupBy)) return null;
    const byKey = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = String(r[groupBy] ?? '—');
      const list = byKey.get(key);
      if (list) list.push(r); else byKey.set(key, [r]);
    }
    return [...byKey.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, groupRows]) => {
        const sums: Record<string, number> = {};
        for (const c of summable) sums[c] = groupRows.reduce((s, r) => s + (Number(r[c]) || 0), 0);
        return { key, rows: groupRows, sums };
      });
  }, [groupBy, groupCandidates, rows, summable]);

  const grandTotal = useMemo(() => {
    if (!groups) return null;
    const sums: Record<string, number> = {};
    for (const c of summable) sums[c] = groups.reduce((s, g) => s + (g.sums[c] ?? 0), 0);
    return sums;
  }, [groups, summable]);

  const signs = new Set(signColumns);
  const toggleGroup = (key: string) => setCollapsedGroups((s) => ({ ...s, [key]: !s[key] }));

  const renderCell = (c: string, v: unknown, ci: number, flagged: boolean) => {
    const sign = signs.has(c) && typeof v === 'number' ? (v < 0 ? 'neg' : v > 0 ? 'pos' : '') : '';
    if (c === badgeColumn) {
      return (
        <td key={c} className={ci === 0 ? 'sticky-col' : undefined}>
          <span className={`badge ${SOURCE_BADGE[String(v)] ?? 'mute'}`}>{String(v ?? '—')}</span>
        </td>
      );
    }
    return (
      <td key={c} className={`${ci === 0 ? 'sticky-col ' : ''}${numeric.has(c) ? 'num' : ''} ${sign}`.trim() || undefined}>
        {ci === 0 && flagged && <span title={flagLabel} style={{ marginRight: 6 }}>⚠</span>}
        {formatCell(c, v)}
      </td>
    );
  };

  if (result.columns.length === 0) {
    return <div className="empty">The query returned no columns.</div>;
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        {groupCandidates.length > 0 && (
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <span className="faint" style={{ fontSize: 12 }}>Group by</span>
            <select value={groupBy} onChange={(e) => { setGroupBy(e.target.value); setCollapsedGroups({}); }}>
              <option value="">None</option>
              {groupCandidates.map((c) => (
                <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </label>
        )}
        <input
          placeholder="Filter rows…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 220 }}
        />
        <div style={{ position: 'relative' }}>
          <button className="btn sm" onClick={() => setPickerOpen((v) => !v)}>Columns ▾</button>
          {pickerOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 9 }} onClick={() => setPickerOpen(false)} />
              <div className="card" style={{ position: 'absolute', top: '110%', left: 0, zIndex: 10,
                     padding: 10, minWidth: 180, maxHeight: 260, overflow: 'auto' }}>
                {displayColumns.map((c) => (
                  <label key={c} className="row" style={{ gap: 8, padding: '3px 0', fontSize: 12.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!hiddenCols.has(c)}
                           onChange={() => setHiddenCols((s) => {
                             const next = new Set(s);
                             if (next.has(c)) next.delete(c); else next.add(c);
                             return next;
                           })} />
                    {c.replace(/_/g, ' ')}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="spacer" />
        <span className="faint" style={{ fontSize: 12 }}>
          {rows.length.toLocaleString()} of {result.rowCount.toLocaleString()} rows · {result.ms} ms
          {result.truncated && ' · truncated'}
        </span>
      </div>

      <div className="table-wrap dtable" style={{ maxHeight }}>
        <table>
          <thead>
            <tr>
              {visibleColumns.map((c, ci) => (
                <th
                  key={c}
                  className={`${ci === 0 ? 'sticky-col ' : ''}${numeric.has(c) ? 'num' : ''}`.trim()}
                  style={{ cursor: 'pointer' }}
                  onClick={() =>
                    setSort((s) => (s?.col === c ? { col: c, dir: s.dir === 1 ? -1 : 1 } : { col: c, dir: 1 }))
                  }
                >
                  {c.replace(/_/g, ' ')}
                  {sort?.col === c ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={visibleColumns.length}><div className="empty">No rows.</div></td></tr>
            )}

            {groups ? groups.map((g) => {
              const open = !collapsedGroups[g.key];
              return (
                <Fragment key={g.key}>
                  <tr className="group-row" style={{ cursor: 'pointer' }}
                      onClick={() => toggleGroup(g.key)}>
                    {visibleColumns.map((c, ci) => {
                      if (ci === 0) {
                        return (
                          <td key={c} className="sticky-col">
                            <span style={{ marginRight: 6 }}>{open ? '▾' : '▸'}</span>
                            {c === groupBy ? g.key : ''}
                            {c === groupBy && <span className="faint" style={{ marginLeft: 6 }}>({g.rows.length})</span>}
                          </td>
                        );
                      }
                      if (c === groupBy) return <td key={c}>{g.key} <span className="faint">({g.rows.length})</span></td>;
                      if (summable.has(c)) {
                        const v = g.sums[c];
                        const sign = signs.has(c) ? (v < 0 ? 'neg' : v > 0 ? 'pos' : '') : '';
                        return <td key={c} className={`num ${sign}`.trim()} style={{ fontWeight: 600 }}>{formatCell(c, v)}</td>;
                      }
                      return <td key={c} />;
                    })}
                  </tr>
                  {open && g.rows.map((r, i) => (
                    <tr key={`${g.key}-${i}`}>
                      {visibleColumns.map((c, ci) => renderCell(c, r[c], ci, false))}
                    </tr>
                  ))}
                </Fragment>
              );
            }) : rows.map((r, i) => {
              const flagged = !!flagColumn && !!Number(r[flagColumn] ?? 0);
              return (
                <tr key={i} style={flagged ? { background: 'rgba(250,178,25,.07)' } : undefined}
                    title={flagged ? (flagLabel ?? 'Flagged') : undefined}>
                  {visibleColumns.map((c, ci) => renderCell(c, r[c], ci, flagged))}
                </tr>
              );
            })}

            {grandTotal && (
              <tr className="group-row" style={{ borderTop: '2px solid var(--border)' }}>
                {visibleColumns.map((c, ci) => {
                  if (ci === 0) return <td key={c} className="sticky-col" style={{ fontWeight: 700 }}>Total</td>;
                  if (summable.has(c)) {
                    const v = grandTotal[c];
                    const sign = signs.has(c) ? (v < 0 ? 'neg' : v > 0 ? 'pos' : '') : '';
                    return <td key={c} className={`num ${sign}`.trim()} style={{ fontWeight: 700 }}>{formatCell(c, v)}</td>;
                  }
                  return <td key={c} />;
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
