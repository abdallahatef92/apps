import { useMemo } from 'react';
import type { QueryResult } from '@shared/types';
import { Tooltip, divergingColor, fmtCompact, fmtFull, useTooltip } from './chrome';

interface Props {
  result: QueryResult;
  labelColumn: string;
  sizeColumn: string;
  /** Signed column driving the diverging fill — e.g. budget variance. */
  colorColumn?: string;
  /** Shown in the tooltip; two elements can legitimately share a name. */
  codeColumn?: string;
  height?: number;
  onSelect?: (code: string) => void;
}

interface Tile { label: string; code: string; size: number; color: number;
                 x: number; y: number; w: number; h: number }

/**
 * Squarified treemap: area is spend, fill is variance against budget.
 *
 * Squarifying (rather than naive slice-and-dice) keeps tiles close to square, so
 * areas stay comparable and labels fit — the usual failure of a treemap is thin
 * slivers nobody can read or compare.
 */
function squarify(items: { label: string; code: string; size: number; color: number }[],
                  x: number, y: number, w: number, h: number): Tile[] {
  const total = items.reduce((s, i) => s + i.size, 0);
  if (total <= 0 || items.length === 0) return [];

  const out: Tile[] = [];
  let rest = items.map((i) => ({ ...i, area: (i.size / total) * w * h }));
  let cx = x, cy = y, cw = w, ch = h;

  const worst = (row: number[], side: number) => {
    const sum = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row), min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  while (rest.length > 0) {
    const side = Math.min(cw, ch);
    const row: typeof rest = [];
    const areas: number[] = [];
    while (rest.length > 0) {
      const next = [...areas, rest[0].area];
      if (areas.length > 0 && worst(next, side) > worst(areas, side)) break;
      areas.push(rest[0].area);
      row.push(rest[0]);
      rest = rest.slice(1);
    }

    const rowArea = areas.reduce((a, b) => a + b, 0);
    const horizontal = cw >= ch;
    const thickness = rowArea / side;
    let offset = horizontal ? cy : cx;

    for (const item of row) {
      const length = item.area / thickness;
      out.push(horizontal
        ? { ...item, x: cx, y: offset, w: thickness, h: length }
        : { ...item, x: offset, y: cy, w: length, h: thickness });
      offset += length;
    }

    if (horizontal) { cx += thickness; cw -= thickness; } else { cy += thickness; ch -= thickness; }
    if (cw <= 0.5 || ch <= 0.5) break;
  }
  return out;
}

export function Treemap({ result, labelColumn, sizeColumn, colorColumn, codeColumn,
                          height = 340, onSelect }: Props) {
  const { tip, show, hide } = useTooltip();
  const W = 1000, H = height;

  const { tiles, extent } = useMemo(() => {
    const items = result.rows
      .map((r) => ({
        label: String(r[labelColumn] ?? '—'),
        code: codeColumn ? String(r[codeColumn] ?? '') : '',
        size: Math.abs(Number(r[sizeColumn] ?? 0)),
        // A null variance means "no budget to compare against", which the
        // diverging scale renders as its neutral midpoint, not as an overrun.
        color: colorColumn && r[colorColumn] !== null && r[colorColumn] !== undefined
          ? Number(r[colorColumn]) : 0,
      }))
      .filter((i) => i.size > 0)
      .sort((a, b) => b.size - a.size)
      .slice(0, 60);
    const ext = Math.max(...items.map((i) => Math.abs(i.color)), 1);
    return { tiles: squarify(items, 0, 0, W, H), extent: ext };
  }, [result, labelColumn, sizeColumn, colorColumn, codeColumn, H]);

  if (tiles.length === 0) return <div className="empty">No data to plot.</div>;

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} role="img">
        {tiles.map((t, i) => {
          const fill = colorColumn ? divergingColor(t.color, extent) : 'var(--series-1)';
          // Only label a tile with room for it; the tooltip covers the rest.
          const showLabel = t.w > 74 && t.h > 30;
          return (
            // Keyed by position, not label: two elements can share a name, and
            // duplicate keys make React reuse the wrong node.
            <g key={`${t.code}|${t.label}|${i}`} style={{ cursor: onSelect ? 'pointer' : 'default' }}
               onClick={() => onSelect?.(t.code || t.label)}
               onMouseMove={(e) => show(e.clientX, e.clientY, t.code ? `${t.code} · ${t.label}` : t.label, [
                 { label: sizeColumn.replace(/_/g, ' '), value: fmtFull(t.size) },
                 ...(colorColumn ? [{
                   label: colorColumn.replace(/_/g, ' '),
                   value: t.color === 0 ? 'no budget' : fmtFull(t.color), color: fill }] : []),
               ])}
               onMouseLeave={hide}>
              {/* 2px surface gap between fills keeps adjacent tiles legible */}
              <rect x={t.x + 1} y={t.y + 1} width={Math.max(0, t.w - 2)} height={Math.max(0, t.h - 2)}
                    fill={fill} rx={3} />
              {showLabel && (
                <>
                  <text x={t.x + 10} y={t.y + 20} fill="#fff" fontSize={11.5} fontWeight={600}>
                    {t.label.length > Math.floor(t.w / 7) ? `${t.label.slice(0, Math.floor(t.w / 7))}…` : t.label}
                  </text>
                  <text x={t.x + 10} y={t.y + 35} fill="rgba(255,255,255,.75)" fontSize={10.5}>
                    {fmtCompact(t.size)}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </>
  );
}
