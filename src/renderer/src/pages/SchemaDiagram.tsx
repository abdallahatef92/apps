import { useEffect, useMemo, useState } from 'react';
import { api, call } from '../lib/api';
import type { SchemaDescription, SchemaTable } from '@shared/types';

/**
 * Visual grouping only — a hint for which column a table's box lands in, not
 * schema truth. A table introspection returns that isn't listed here falls
 * into "Other" rather than being dropped, so a future migration's table still
 * shows up.
 */
const GROUPS: { label: string; color: string; tables: string[] }[] = [
  {
    label: 'Lineage & staging', color: 'var(--series-2)',
    tables: ['source_system', 'report_definition', 'module_type', 'import_batch',
             'stg_row', 'column_mapping', 'value_mapping'],
  },
  {
    label: 'Dimensions', color: 'var(--series-1)',
    tables: ['dim_date', 'dim_period', 'dim_currency', 'dim_project', 'dim_wbs',
             'dim_cost_element', 'dim_cost_type', 'dim_vendor', 'dim_scenario'],
  },
  {
    label: 'Facts', color: 'var(--series-3)',
    tables: ['fact_actual', 'fact_budget', 'fact_forecast', 'fact_service_line', 'fact_order_line'],
  },
  {
    label: 'Library & admin', color: 'var(--series-4)',
    tables: ['cost_type_rule', 'query_library', 'query_run_log', 'app_setting'],
  },
];
const OTHER_COLOR = 'var(--series-7)';

const COL_WIDTH = 250;
const COL_GAP = 90;
const BOX_GAP = 26;
const HEADER_H = 30;
const ROW_H = 19;
const PAD = 24;

interface Rect { x: number; y: number; w: number; h: number; group: number }

export function SchemaDiagram() {
  const [schema, setSchema] = useState<SchemaDescription | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call(api.schema.describe()).then(setSchema).catch((e) => setError((e as Error).message));
  }, []);

  const layout = useMemo(() => {
    if (!schema) return null;
    const byName = new Map(schema.tables.map((t) => [t.name, t]));
    const groupOf = (name: string) => {
      const i = GROUPS.findIndex((g) => g.tables.includes(name));
      return i === -1 ? GROUPS.length : i;
    };
    const columns: SchemaTable[][] = Array.from({ length: GROUPS.length + 1 }, () => []);
    for (const g of GROUPS) for (const name of g.tables) { const t = byName.get(name); if (t) columns[groupOf(name)].push(t); }
    for (const t of schema.tables) if (groupOf(t.name) === GROUPS.length && !columns[GROUPS.length].includes(t)) columns[GROUPS.length].push(t);

    const rects = new Map<string, Rect>();
    columns.forEach((tables, g) => {
      let y = PAD;
      const x = PAD + g * (COL_WIDTH + COL_GAP);
      for (const t of tables) {
        const h = HEADER_H + t.columns.length * ROW_H;
        rects.set(t.name, { x, y, w: COL_WIDTH, h, group: g });
        y += h + BOX_GAP;
      }
    });

    const width = PAD * 2 + columns.length * COL_WIDTH + (columns.length - 1) * COL_GAP;
    const height = Math.max(200, ...[...rects.values()].map((r) => r.y + r.h)) + PAD;

    const rowY = (table: string, column: string) => {
      const t = byName.get(table); const r = rects.get(table);
      if (!t || !r) return null;
      const idx = t.columns.findIndex((c) => c.name === column);
      return idx === -1 ? null : r.y + HEADER_H + idx * ROW_H + ROW_H / 2;
    };

    const edges: { from: string; to: string; d: string }[] = [];
    for (const t of schema.tables) {
      for (const fk of t.foreignKeys) {
        const src = rects.get(t.name); const dst = rects.get(fk.refTable);
        if (!src || !dst) continue;
        const y1 = rowY(t.name, fk.column) ?? src.y + HEADER_H / 2;
        const y2 = rowY(fk.refTable, fk.refColumn) ?? dst.y + HEADER_H / 2;
        let d: string;
        if (fk.refTable === t.name) {
          const x = src.x;
          d = `M ${x},${y1} C ${x - 44},${y1} ${x - 44},${y2} ${x},${y2}`;
        } else if (dst.x >= src.x) {
          const x1 = src.x + src.w, x2 = dst.x;
          const dx = Math.max(40, (x2 - x1) * 0.4);
          d = `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
        } else {
          const x1 = src.x, x2 = dst.x + dst.w;
          const dx = Math.max(40, (x1 - x2) * 0.4);
          d = `M ${x1},${y1} C ${x1 - dx},${y1} ${x2 + dx},${y2} ${x2},${y2}`;
        }
        edges.push({ from: t.name, to: fk.refTable, d });
      }
    }

    return { columns, rects, edges, width, height };
  }, [schema]);

  const matches = (t: SchemaTable) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q));
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <h3>Schema diagram</h3>
          <p className="hint" style={{ marginBottom: 0 }}>
            Every base table (no views), read live from the database — always matches what the
            migrations actually created. Click a table to trace its foreign keys.
          </p>
        </div>
        <input placeholder="Search tables or columns…" value={search} style={{ width: 240 }}
               onChange={(e) => setSearch(e.target.value)} />
      </div>

      {error && <div className="banner err">{error}</div>}

      {!schema || !layout ? (
        <div className="empty">Loading…</div>
      ) : (
        <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 220px)', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius-s)' }}>
          <svg width={layout.width} height={layout.height} style={{ display: 'block' }}>
            <defs>
              <marker id="fk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--text-3)" />
              </marker>
            </defs>

            {layout.edges.map((e, i) => {
              const dim = selected && selected !== e.from && selected !== e.to;
              return (
                <path key={i} d={e.d} fill="none" markerEnd="url(#fk-arrow)"
                      stroke={selected && !dim ? 'var(--accent)' : 'var(--text-3)'}
                      strokeWidth={selected && !dim ? 1.6 : 1}
                      opacity={dim ? 0.15 : selected ? 1 : 0.55} />
              );
            })}

            {schema.tables.map((t) => {
              const r = layout.rects.get(t.name);
              if (!r) return null;
              const groupColor = GROUPS[r.group]?.color ?? OTHER_COLOR;
              const dim = search.trim() && !matches(t);
              const isSelected = selected === t.name;
              const isNeighbor = selected != null && !isSelected && layout.edges.some(
                (e) => (e.from === selected && e.to === t.name) || (e.to === selected && e.from === t.name));
              return (
                <g key={t.name} opacity={dim ? 0.25 : 1} style={{ cursor: 'pointer' }}
                   onClick={() => setSelected((s) => (s === t.name ? null : t.name))}>
                  <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={6}
                        fill="var(--surface-2)"
                        stroke={isSelected ? 'var(--accent)' : isNeighbor ? groupColor : 'var(--border)'}
                        strokeWidth={isSelected ? 2 : 1} />
                  <rect x={r.x} y={r.y} width={r.w} height={HEADER_H} rx={6} fill={groupColor} opacity={0.85} />
                  <rect x={r.x} y={r.y + HEADER_H - 6} width={r.w} height={6} fill={groupColor} opacity={0.85} />
                  <text x={r.x + 10} y={r.y + HEADER_H / 2 + 4} className="mono"
                        fill="var(--text)" fontWeight={700} fontSize={12}>{t.name}</text>
                  {t.columns.map((c, i) => {
                    const isFk = t.foreignKeys.some((fk) => fk.column === c.name);
                    const y = r.y + HEADER_H + i * ROW_H + ROW_H / 2 + 4;
                    return (
                      <g key={c.name}>
                        <text x={r.x + 10} y={y} className="mono" fontSize={11}
                              fill={c.isPk ? 'var(--text)' : 'var(--text-2)'} fontWeight={c.isPk ? 700 : 400}>
                          {c.isPk ? 'PK ' : isFk ? 'FK ' : '   '}{c.name}
                        </text>
                        <text x={r.x + r.w - 10} y={y} textAnchor="end" className="mono" fontSize={10}
                              fill="var(--text-3)">{c.type}{c.notNull ? ' •' : ''}</text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
