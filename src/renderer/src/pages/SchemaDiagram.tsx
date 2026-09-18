import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, call } from '../lib/api';
import type { SchemaDescription, SchemaTable } from '@shared/types';

/**
 * Visual grouping only — a hint for which column a table's box lands in, not
 * schema truth. A table introspection returns that isn't listed here falls
 * into "Other" rather than being dropped, so a future migration's table still
 * shows up.
 *
 * Colours are literal hex (matching the tokens in styles.css) rather than
 * var(--…) — the exported SVG/PNG is a standalone document with no access to
 * the app's stylesheet, so anything drawn on screen must already be a value
 * that survives export unchanged.
 */
const COLORS = {
  surface: '#121822', surface2: '#172030', border: '#223047', borderSoft: '#1a2433',
  text: '#eef3f8', text2: '#a9b7c7', text3: '#6f8195', accent: '#3987e5',
};
const GROUPS: { label: string; color: string; tables: string[] }[] = [
  {
    label: 'Lineage & staging', color: '#d95926',
    tables: ['source_system', 'report_definition', 'module_type', 'import_batch',
             'stg_row', 'column_mapping', 'value_mapping'],
  },
  {
    label: 'Dimensions', color: '#3987e5',
    tables: ['dim_date', 'dim_period', 'dim_currency', 'dim_project', 'dim_wbs',
             'dim_cost_element', 'dim_cost_type', 'dim_vendor', 'dim_scenario'],
  },
  {
    label: 'Facts', color: '#199e70',
    tables: ['fact_actual', 'fact_budget', 'fact_forecast', 'fact_service_line', 'fact_order_line'],
  },
  {
    label: 'Library & admin', color: '#c98500',
    tables: ['cost_type_rule', 'query_library', 'query_run_log', 'app_setting'],
  },
];
const OTHER_COLOR = '#9085e9';

const COL_WIDTH = 250;
const COL_GAP = 90;
const BOX_GAP = 26;
const HEADER_H = 30;
const ROW_H = 19;
const PAD = 24;
const MIN_SCALE = 0.4;
const MAX_SCALE = 6;

interface Rect { x: number; y: number; w: number; h: number; group: number }
interface View { x: number; y: number; w: number; h: number }

export function SchemaDiagram() {
  const [schema, setSchema] = useState<SchemaDescription | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; view: View; moved: boolean } | null>(null);
  /** Set when a drag actually moved the view, so the click that follows mouseup doesn't select a table. */
  const suppressClickRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

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

  // Reset the viewBox to a 1:1 fit whenever a fresh layout arrives.
  useEffect(() => {
    if (layout) setView({ x: 0, y: 0, w: layout.width, h: layout.height });
  }, [layout]);

  const matches = (t: SchemaTable) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q));
  };

  const clampView = useCallback((v: View): View => {
    if (!layout) return v;
    const minW = layout.width / MAX_SCALE, maxW = layout.width / MIN_SCALE;
    const w = Math.min(maxW, Math.max(minW, v.w));
    const h = w * (layout.height / layout.width);
    return { x: v.x, y: v.y, w, h };
  }, [layout]);

  const zoomAt = useCallback((factor: number, clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container || !view) return;
    const rect = container.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const userX = view.x + px * view.w;
    const userY = view.y + py * view.h;
    const next = clampView({ x: 0, y: 0, w: view.w * factor, h: view.h * factor });
    setView({ x: userX - px * next.w, y: userY - py * next.h, w: next.w, h: next.h });
  }, [view, clampView]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    zoomAt(factor, e.clientX, e.clientY);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !view) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, view, moved: false };
    setIsDragging(true);
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      const container = containerRef.current;
      if (!d || !container) return;
      const rect = container.getBoundingClientRect();
      const dx = (ev.clientX - d.startX) * (d.view.w / rect.width);
      const dy = (ev.clientY - d.startY) * (d.view.h / rect.height);
      if (Math.abs(ev.clientX - d.startX) > 3 || Math.abs(ev.clientY - d.startY) > 3) d.moved = true;
      setView({ x: d.view.x - dx, y: d.view.y - dy, w: d.view.w, h: d.view.h });
    };
    const onUp = () => {
      suppressClickRef.current = dragRef.current?.moved ?? false;
      dragRef.current = null;
      setIsDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const zoomButton = (factor: number) => () => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };
  const resetView = () => { if (layout) setView({ x: 0, y: 0, w: layout.width, h: layout.height }); };
  const scalePct = layout && view ? Math.round((layout.width / view.w) * 100) : 100;

  /** A clean copy of the diagram at its natural, un-panned/zoomed size — what gets exported. */
  const buildExportSvg = (): string | null => {
    const svg = svgRef.current;
    if (!svg || !layout) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    clone.setAttribute('width', String(layout.width));
    clone.setAttribute('height', String(layout.height));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
    bg.setAttribute('width', String(layout.width)); bg.setAttribute('height', String(layout.height));
    bg.setAttribute('fill', COLORS.surface);
    clone.insertBefore(bg, clone.firstChild);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  };

  const exportSvg = async () => {
    const data = buildExportSvg();
    if (!data) return;
    setBusy(true); setError(null); setSavedTo(null);
    try {
      const path = await call(api.schema.exportDiagram({ format: 'svg', data, suggestedName: 'schema-diagram' }));
      if (path) setSavedTo(path);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const exportPng = async () => {
    const svgText = buildExportSvg();
    if (!svgText || !layout) return;
    setBusy(true); setError(null); setSavedTo(null);
    try {
      const scale = 2; // sharper than 1:1 on a high-DPI screen
      // A blob: URL would be blocked by the page's CSP (img-src is 'self' data:
      // only) — a data: URI is both allowed and needs no revoke bookkeeping.
      const svgDataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = layout.width * scale;
          canvas.height = layout.height * scale;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('canvas unavailable')); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('Failed to rasterize the diagram.'));
        img.src = svgDataUri;
      });
      const base64 = dataUrl.split(',')[1];
      const path = await call(api.schema.exportDiagram({ format: 'png', data: base64, suggestedName: 'schema-diagram' }));
      if (path) setSavedTo(path);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h3>Schema diagram</h3>
          <p className="hint" style={{ marginBottom: 0 }}>
            Every base table (no views), read live from the database — always matches what the
            migrations actually created. Click a table to trace its foreign keys, scroll to zoom,
            drag to pan.
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input placeholder="Search tables or columns…" value={search} style={{ width: 220 }}
                 onChange={(e) => setSearch(e.target.value)} />
          <div className="row" style={{ gap: 4 }}>
            <button className="btn sm" onClick={zoomButton(1 / 1.3)} disabled={!layout} title="Zoom in">＋</button>
            <button className="btn sm" onClick={zoomButton(1.3)} disabled={!layout} title="Zoom out">－</button>
            <button className="btn sm" onClick={resetView} disabled={!layout} title="Reset view">⤢ Fit</button>
            <span className="faint mono" style={{ alignSelf: 'center', fontSize: 12, minWidth: 40 }}>{scalePct}%</span>
          </div>
          <button className="btn sm" onClick={exportSvg} disabled={busy || !layout}>⤓ SVG</button>
          <button className="btn sm" onClick={exportPng} disabled={busy || !layout}>⤓ PNG</button>
        </div>
      </div>

      {error && <div className="banner err">{error}</div>}
      {savedTo && (
        <div className="banner ok">
          Exported to <span className="mono">{savedTo}</span>
          <button className="btn sm ghost" style={{ marginLeft: 10 }} onClick={() => api.showItem(savedTo)}>Show in folder</button>
        </div>
      )}

      {!schema || !layout || !view ? (
        <div className="empty">Loading…</div>
      ) : (
        <div ref={containerRef}
             style={{ overflow: 'hidden', height: 'calc(100vh - 260px)', border: '1px solid var(--border-soft)',
                       borderRadius: 'var(--radius-s)', cursor: isDragging ? 'grabbing' : 'grab' }}
             onWheel={onWheel}
             onMouseDown={onMouseDown}>
          <svg ref={svgRef} width="100%" height="100%" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
               style={{ display: 'block' }}>
            <defs>
              <marker id="fk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={COLORS.text3} />
              </marker>
            </defs>

            {layout.edges.map((e, i) => {
              const dim = selected && selected !== e.from && selected !== e.to;
              return (
                <path key={i} d={e.d} fill="none" markerEnd="url(#fk-arrow)"
                      stroke={selected && !dim ? COLORS.accent : COLORS.text3}
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
                   onClick={(e) => {
                     e.stopPropagation();
                     if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                     setSelected((s) => (s === t.name ? null : t.name));
                   }}>
                  <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={6}
                        fill={COLORS.surface2}
                        stroke={isSelected ? COLORS.accent : isNeighbor ? groupColor : COLORS.border}
                        strokeWidth={isSelected ? 2 : 1} />
                  <rect x={r.x} y={r.y} width={r.w} height={HEADER_H} rx={6} fill={groupColor} opacity={0.85} />
                  <rect x={r.x} y={r.y + HEADER_H - 6} width={r.w} height={6} fill={groupColor} opacity={0.85} />
                  <text x={r.x + 10} y={r.y + HEADER_H / 2 + 4} className="mono"
                        fill={COLORS.text} fontWeight={700} fontSize={12}>{t.name}</text>
                  {t.columns.map((c, i) => {
                    const isFk = t.foreignKeys.some((fk) => fk.column === c.name);
                    const y = r.y + HEADER_H + i * ROW_H + ROW_H / 2 + 4;
                    return (
                      <g key={c.name}>
                        <text x={r.x + 10} y={y} className="mono" fontSize={11}
                              fill={c.isPk ? COLORS.text : COLORS.text2} fontWeight={c.isPk ? 700 : 400}>
                          {c.isPk ? 'PK ' : isFk ? 'FK ' : '   '}{c.name}
                        </text>
                        <text x={r.x + r.w - 10} y={y} textAnchor="end" className="mono" fontSize={10}
                              fill={COLORS.text3}>{c.type}{c.notNull ? ' •' : ''}</text>
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
