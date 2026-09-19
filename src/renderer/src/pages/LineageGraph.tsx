import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { DataTable } from '../components/DataTable';
import { buildExportSvg, rasterizeSvgToPng, useGraphCanvas } from '../components/GraphCanvas';
import type { LineageResult, QueryResult, ReportDefinition } from '@shared/types';

const COLORS = {
  surface: '#121822', surface2: '#172030', border: '#223047',
  text: '#eef3f8', text2: '#a9b7c7', text3: '#6f8195', accent: '#3987e5',
};
const STAGE_COLOR = { source: '#d95926', staging: '#c98500', fact: '#3987e5', view: '#199e70', query: '#9085e9' };

const COL_WIDTH = 230;
const COL_GAP = 80;
const BOX_GAP = 20;
const HEADER_H = 26;
const LINE_H = 16;
const PAD_V = 8;
const PAD = 24;

type Kind = 'source' | 'staging' | 'fact' | 'view' | 'query' | 'summary';
interface Node { id: string; kind: Kind; title: string; lines: string[]; code?: string; sources?: string[] }
interface Rect { x: number; y: number; w: number; h: number; kind: Kind }

export function LineageGraph() {
  const { projectKey } = useApp();
  const [reports, setReports] = useState<ReportDefinition[]>([]);
  const [reportId, setReportId] = useState<number | null>(null);
  const [lineage, setLineage] = useState<LineageResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; result?: QueryResult; text?: string; error?: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  useEffect(() => {
    call(api.reports.list()).then((r) => {
      setReports(r as ReportDefinition[]);
      setReportId((r as ReportDefinition[])[0]?.report_definition_id ?? null);
    }).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (!reportId) { setLineage(null); return; }
    setExpanded(false); setSelectedId(null); setPreview(null); setError(null);
    call(api.lineage.forReport(reportId)).then(setLineage).catch((e) => setError((e as Error).message));
  }, [reportId]);

  const byModule = useMemo(() => {
    const map = new Map<string, ReportDefinition[]>();
    for (const r of reports) map.set(r.module, [...(map.get(r.module) ?? []), r]);
    return [...map.entries()];
  }, [reports]);

  const layout = useMemo(() => {
    if (!lineage) return null;
    const columns: Node[][] = [[], [], [], [], []];

    columns[0].push({
      id: 'source', kind: 'source', title: lineage.report.name,
      lines: [lineage.report.source_system, lineage.report.module, ...(lineage.report.description ? [lineage.report.description] : [])],
    });

    const b = lineage.latestBatch;
    columns[1].push({
      id: 'staging', kind: 'staging', title: 'Staging',
      lines: b ? [`${b.status} · ${b.data_date}`, `${b.row_count_posted.toLocaleString()} rows posted`] : ['No batches yet'],
    });

    if (lineage.fact) {
      columns[2].push({
        id: 'fact', kind: 'fact', title: lineage.fact.name,
        lines: [lineage.fact.isDimension ? 'Dimension' : 'Fact table'],
      });
    }

    for (const v of lineage.views) {
      columns[3].push({ id: `view:${v.name}`, kind: 'view', title: v.name, lines: ['View'] });
    }

    if (expanded) {
      for (const q of lineage.queries) {
        columns[4].push({
          id: `query:${q.code}`, kind: 'query', title: q.name,
          lines: [q.category ?? '', q.code], code: q.code, sources: q.sources,
        });
      }
      if (lineage.queries.length === 0) {
        columns[4].push({ id: 'summary', kind: 'summary', title: 'No queries read this data yet', lines: [] });
      }
    } else {
      columns[4].push({
        id: 'summary', kind: 'summary',
        title: `${lineage.queries.length} ${lineage.queries.length === 1 ? 'query reads' : 'queries read'} this data`,
        lines: lineage.queries.length ? ['Click to expand'] : [],
      });
    }

    const rects = new Map<string, Rect>();
    columns.forEach((nodes, g) => {
      let y = PAD;
      const x = PAD + g * (COL_WIDTH + COL_GAP);
      for (const n of nodes) {
        const h = HEADER_H + PAD_V * 2 + Math.max(1, n.lines.length) * LINE_H;
        rects.set(n.id, { x, y, w: COL_WIDTH, h, kind: n.kind });
        y += h + BOX_GAP;
      }
    });

    const width = PAD * 2 + columns.length * COL_WIDTH + (columns.length - 1) * COL_GAP;
    const height = Math.max(200, ...[...rects.values()].map((r) => r.y + r.h)) + PAD;

    const edge = (fromId: string, toId: string) => {
      const src = rects.get(fromId), dst = rects.get(toId);
      if (!src || !dst) return null;
      const y1 = src.y + src.h / 2, y2 = dst.y + dst.h / 2;
      if (src.x === dst.x) {
        const x = src.x;
        return `M ${x},${y1} C ${x - 44},${y1} ${x - 44},${y2} ${x},${y2}`;
      }
      const x1 = src.x + src.w, x2 = dst.x;
      const dx = Math.max(40, (x2 - x1) * 0.4);
      return `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    };

    const nodeIdFor = (name: string) => (lineage.fact?.name === name ? 'fact' : `view:${name}`);

    const edges: { from: string; to: string; d: string }[] = [];
    const push = (from: string, to: string) => { const d = edge(from, to); if (d) edges.push({ from, to, d }); };
    push('source', 'staging');
    if (lineage.fact) push('staging', 'fact');
    for (const v of lineage.views) push(nodeIdFor(v.from), `view:${v.name}`);

    if (expanded) {
      for (const q of lineage.queries) for (const s of q.sources) push(nodeIdFor(s), `query:${q.code}`);
    } else if (lineage.queries.length) {
      const feeders = new Set(lineage.queries.flatMap((q) => q.sources.map(nodeIdFor)));
      for (const f of feeders) push(f, 'summary');
    }

    return { columns, rects, edges, width, height };
  }, [lineage, expanded]);

  const canvas = useGraphCanvas(layout?.width ?? 0, layout?.height ?? 0);
  const { view, containerRef, svgRef, suppressClickRef } = canvas;

  useEffect(() => {
    if (layout) canvas.fitTo(layout.width, layout.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout?.width, layout?.height]);

  const allNodes = layout ? layout.columns.flat() : [];

  const runPreview = async (node: Node) => {
    setSelectedId(node.id); setPreviewBusy(true); setPreview(null);
    try {
      if (node.kind === 'source') {
        setPreview({ title: node.title, text: [lineage?.report.source_system, lineage?.report.module, lineage?.report.description].filter(Boolean).join(' · ') });
      } else if (node.kind === 'staging') {
        const b = lineage?.latestBatch;
        setPreview({ title: 'Staging', text: b ? `Batch #${b.import_batch_id} · ${b.status} · data date ${b.data_date} · imported ${b.imported_at} · ${b.row_count_posted.toLocaleString()} rows posted` : 'No batches yet.' });
      } else if (node.kind === 'fact' || node.kind === 'view') {
        const result = await call(api.queries.runSql(`SELECT * FROM "${node.title}" LIMIT 8`, {}));
        setPreview({ title: node.title, result });
      } else if (node.kind === 'query' && node.code) {
        try {
          const result = await call(api.queries.run(node.code, { project_key: projectKey }));
          setPreview({ title: node.title, result });
        } catch (e) {
          const q = lineage?.queries.find((x) => x.code === node.code);
          setPreview({ title: node.title, text: q?.description ?? (e as Error).message, error: (e as Error).message });
        }
      }
    } catch (e) {
      setPreview({ title: node.title, error: (e as Error).message });
    } finally { setPreviewBusy(false); }
  };

  const onNodeClick = (node: Node) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    if (node.kind === 'summary' && lineage && lineage.queries.length > 0) { setExpanded((v) => !v); return; }
    runPreview(node);
  };

  const exportSvg = async () => {
    if (!layout) return;
    const data = buildExportSvg(svgRef.current, layout.width, layout.height, COLORS.surface);
    if (!data) return;
    setBusy(true); setError(null); setSavedTo(null);
    try {
      const path = await call(api.exportDiagram({ format: 'svg', data, suggestedName: 'lineage' }));
      if (path) setSavedTo(path);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const exportPng = async () => {
    if (!layout) return;
    const svgText = buildExportSvg(svgRef.current, layout.width, layout.height, COLORS.surface);
    if (!svgText) return;
    setBusy(true); setError(null); setSavedTo(null);
    try {
      const dataUrl = await rasterizeSvgToPng(svgText, layout.width, layout.height);
      const path = await call(api.exportDiagram({ format: 'png', data: dataUrl.split(',')[1], suggestedName: 'lineage' }));
      if (path) setSavedTo(path);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h3>Data lineage</h3>
          <p className="hint" style={{ marginBottom: 0 }}>
            One source report's path from upload to every query that reads its data — computed
            live from the schema and each query's own SQL, not a hand-kept map. Click a table or
            view for a live preview; click the queries box to trace who actually uses this data.
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select value={reportId ?? ''} onChange={(e) => setReportId(Number(e.target.value))} style={{ minWidth: 260 }}>
            {byModule.map(([mod, list]) => (
              <optgroup key={mod} label={mod}>
                {list.map((r) => <option key={r.report_definition_id} value={r.report_definition_id}>{r.name}</option>)}
              </optgroup>
            ))}
          </select>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn sm" onClick={canvas.zoomButton(1 / 1.3)} disabled={!layout} title="Zoom in">＋</button>
            <button className="btn sm" onClick={canvas.zoomButton(1.3)} disabled={!layout} title="Zoom out">－</button>
            <button className="btn sm" onClick={canvas.resetView} disabled={!layout} title="Reset view">⤢ Fit</button>
            <span className="faint mono" style={{ alignSelf: 'center', fontSize: 12, minWidth: 40 }}>{canvas.scalePct}%</span>
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

      {!lineage || !layout ? (
        <div className="empty">{reportId ? 'Loading…' : 'No source reports configured yet.'}</div>
      ) : (
        <>
          <div ref={containerRef}
               style={{ overflow: 'hidden', height: '52vh', border: '1px solid var(--border-soft)',
                         borderRadius: 'var(--radius-s)', cursor: canvas.isDragging ? 'grabbing' : 'grab' }}
               onWheel={canvas.onWheel}
               onMouseDown={canvas.onMouseDown}>
            <svg ref={svgRef} width="100%" height="100%" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                 style={{ display: 'block' }}>
              <defs>
                <marker id="lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={COLORS.text3} />
                </marker>
              </defs>

              {layout.edges.map((e, i) => {
                const on = selectedId && (selectedId === e.from || selectedId === e.to);
                return (
                  <path key={i} d={e.d} fill="none" markerEnd="url(#lineage-arrow)"
                        stroke={on ? COLORS.accent : COLORS.text3} strokeWidth={on ? 1.6 : 1}
                        opacity={selectedId ? (on ? 1 : 0.2) : 0.55} />
                );
              })}

              {allNodes.map((n) => {
                const r = layout.rects.get(n.id);
                if (!r) return null;
                const color = n.kind === 'summary' ? STAGE_COLOR.query : STAGE_COLOR[n.kind];
                const isSelected = selectedId === n.id;
                return (
                  <g key={n.id} style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); onNodeClick(n); }}>
                    <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={6}
                          fill={COLORS.surface2} stroke={isSelected ? COLORS.accent : COLORS.border}
                          strokeWidth={isSelected ? 2 : 1} />
                    <rect x={r.x} y={r.y} width={r.w} height={HEADER_H} rx={6} fill={color} opacity={0.85} />
                    <rect x={r.x} y={r.y + HEADER_H - 6} width={r.w} height={6} fill={color} opacity={0.85} />
                    <text x={r.x + 10} y={r.y + HEADER_H / 2 + 4} className="mono" fontWeight={700} fontSize={11.5}
                          fill={COLORS.text}>
                      {n.title.length > 30 ? `${n.title.slice(0, 29)}…` : n.title}
                    </text>
                    {n.lines.map((line, i) => (
                      <text key={i} x={r.x + 10} y={r.y + HEADER_H + PAD_V + i * LINE_H + LINE_H / 2 + 3}
                            className="mono" fontSize={10.5} fill={COLORS.text2}>
                        {line.length > 34 ? `${line.slice(0, 33)}…` : line}
                      </text>
                    ))}
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="card" style={{ marginTop: 14, marginBottom: 0 }}>
            <h3 style={{ fontSize: 14 }}>{preview ? preview.title : 'Preview'}</h3>
            {previewBusy ? (
              <div className="empty">Running…</div>
            ) : !preview ? (
              <div className="empty">Click a node above to preview its data.</div>
            ) : preview.error ? (
              <div className="banner err">{preview.error}</div>
            ) : preview.result ? (
              <DataTable result={preview.result} maxHeight={260} />
            ) : (
              <p className="hint" style={{ marginBottom: 0 }}>{preview.text}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
