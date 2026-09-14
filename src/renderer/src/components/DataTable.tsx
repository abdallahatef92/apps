import { useMemo, useState } from 'react';
import { formatCell, isNumericColumn } from '../lib/format';
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
 * Renders a result set exactly as SQL returned it — no client-side aggregation.
 * Sorting and the text filter are presentation only.
 */
export function DataTable({
  result, maxHeight = 520, signColumns = [], badgeColumn, flagColumn, flagLabel,
}: Props) {
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');

  const numeric = useMemo(() => {
    const first = result.rows[0] ?? {};
    return new Set(result.columns.filter((c) => isNumericColumn(c, first[c])));
  }, [result]);

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

  const signs = new Set(signColumns);
  // The flag column drives row styling only; it never appears as its own cell.
  const visibleColumns = flagColumn ? result.columns.filter((c) => c !== flagColumn) : result.columns;

  if (result.columns.length === 0) {
    return <div className="empty">The query returned no columns.</div>;
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          placeholder="Filter rows…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 240 }}
        />
        <span className="faint" style={{ fontSize: 12 }}>
          {rows.length.toLocaleString()} of {result.rowCount.toLocaleString()} rows · {result.ms} ms
          {result.truncated && ' · truncated'}
        </span>
      </div>

      <div className="table-wrap" style={{ maxHeight }}>
        <table>
          <thead>
            <tr>
              {visibleColumns.map((c) => (
                <th
                  key={c}
                  className={numeric.has(c) ? 'num' : undefined}
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
            {rows.map((r, i) => {
              const flagged = !!flagColumn && !!Number(r[flagColumn] ?? 0);
              return (
                <tr key={i} style={flagged ? { background: 'rgba(250,178,25,.07)' } : undefined}
                    title={flagged ? (flagLabel ?? 'Flagged') : undefined}>
                  {visibleColumns.map((c, ci) => {
                    const v = r[c];
                    const sign = signs.has(c) && typeof v === 'number' ? (v < 0 ? 'neg' : v > 0 ? 'pos' : '') : '';
                    if (c === badgeColumn) {
                      return (
                        <td key={c}>
                          <span className={`badge ${SOURCE_BADGE[String(v)] ?? 'mute'}`}>{String(v ?? '—')}</span>
                        </td>
                      );
                    }
                    return (
                      <td key={c} className={`${numeric.has(c) ? 'num' : ''} ${sign}`.trim() || undefined}>
                        {ci === 0 && flagged && <span title={flagLabel} style={{ marginRight: 6 }}>⚠</span>}
                        {formatCell(c, v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
