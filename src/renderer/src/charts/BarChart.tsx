import type { QueryResult } from '@shared/types';
import { SERIES, Tooltip, divergingColor, fmtCompact, fmtFull, useTooltip } from './chrome';

interface Props {
  result: QueryResult;
  labelColumn: string;
  valueColumn: string;
  limit?: number;
  /** Signed values: bars grow either side of a zero line, coloured by sign. */
  diverging?: boolean;
  /** Optional second column shown as a faint reference bar behind the value. */
  referenceColumn?: string;
  referenceLabel?: string;
}

/**
 * Horizontal bars — the right form for ranked categories, because the labels
 * read straight across instead of being turned on their side.
 */
export function BarChart({
  result, labelColumn, valueColumn, limit = 14, diverging = false,
  referenceColumn, referenceLabel,
}: Props) {
  const { tip, show, hide } = useTooltip();
  const rows = result.rows.slice(0, limit);
  if (rows.length === 0) return <div className="empty">No data to plot.</div>;

  const values = rows.map((r) => Number(r[valueColumn] ?? 0));
  const refs = referenceColumn ? rows.map((r) => Number(r[referenceColumn] ?? 0)) : [];
  const extent = Math.max(...values.map(Math.abs), ...refs.map(Math.abs), 1);

  return (
    <>
      {result.rows.length > rows.length && (
        <div className="faint" style={{ fontSize: 11.5, marginBottom: 9 }}>
          Top {rows.length} of {result.rows.length.toLocaleString()} — the table has them all.
        </div>
      )}
      <div style={{ display: 'grid', gap: 7 }}>
        {rows.map((r, i) => {
          const v = values[i];
          const ref = referenceColumn ? refs[i] : null;
          const pct = (Math.abs(v) / extent) * 100;
          const refPct = ref !== null ? (Math.abs(ref) / extent) * 100 : 0;
          const label = String(r[labelColumn] ?? '—');

          const onEnter = (e: React.MouseEvent) => show(e.clientX, e.clientY, label, [
            ...(ref !== null ? [{ label: referenceLabel ?? referenceColumn!, value: fmtFull(ref),
                                  color: 'var(--text-3)' }] : []),
            { label: valueColumn.replace(/_/g, ' '), value: fmtFull(v),
              color: diverging ? divergingColor(v, extent) : SERIES[0] },
          ]);

          return (
            <div key={i} onMouseMove={onEnter} onMouseLeave={hide}
                 style={{ display: 'grid', gridTemplateColumns: '190px 1fr 96px',
                          gap: 12, alignItems: 'center', cursor: 'default' }}>
              <span className="faint nowrap" title={label}
                    style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>

              <div style={{ position: 'relative', height: 18 }}>
                {diverging ? (
                  <>
                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0,
                                  width: 1, background: 'var(--axis)' }} />
                    <div style={{
                      position: 'absolute', top: 1, bottom: 1,
                      left: v < 0 ? `${50 - pct / 2}%` : '50%',
                      width: `${pct / 2}%`,
                      background: divergingColor(v, extent),
                      borderRadius: v < 0 ? '4px 0 0 4px' : '0 4px 4px 0',
                    }} />
                  </>
                ) : (
                  <>
                    {ref !== null && (
                      <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${refPct}%`,
                                    background: 'var(--surface-3)', borderRadius: 4 }} />
                    )}
                    <div style={{ position: 'absolute', top: ref !== null ? 4 : 1,
                                  bottom: ref !== null ? 4 : 1, left: 0, width: `${pct}%`,
                                  background: SERIES[0], borderRadius: 4 }} />
                  </>
                )}
              </div>

              <span className="mono right" style={{ fontSize: 12 }}>{fmtCompact(v)}</span>
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} />
    </>
  );
}
