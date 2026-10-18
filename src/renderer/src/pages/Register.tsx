import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { money, pct } from '../lib/format';
import { MonthPivot } from '../components/MonthPivot';
import { DataTable } from '../components/DataTable';
import { SheetTabs } from '../components/SheetTabs';
import type { QueryResult } from '@shared/types';

type RowsBy = 'item' | 'package' | 'wbs';
const ROWS_LABEL: Record<RowsBy, string> = { item: 'Item (GL / PO / material / service / order)', package: 'Work package', wbs: 'WBS' };
const SOURCES = [
  { v: '', label: 'All sources' }, { v: 'CJI3', label: 'CJI3' }, { v: 'CERT', label: 'Certificates' },
  { v: 'MB51', label: 'MB51' }, { v: 'ORDER', label: 'Order detail' },
];

/**
 * The Actual cost register (simplification step 3): the monthly actual cost report for every cost type,
 * read from v_actual_cost — CJI3 where no detail is loaded, the detail (certificates / MB51 / orders) where
 * it is. Per month or cumulative, by item, work package or WBS; click a row for its lines; one workbook
 * export. Replaces the Project dashboard, Actual cost and Cost Report pages in the menu.
 */
export function Register() {
  const { projectKey, project, dataVersion } = useApp();
  const [rowsBy, setRowsBy] = useState<RowsBy>('item');
  const [source, setSource] = useState('');
  const [kpi, setKpi] = useState<Record<string, unknown> | null>(null);
  const [monthly, setMonthly] = useState<QueryResult | null>(null);
  const [lines, setLines] = useState<QueryResult | null>(null);
  const [recon, setRecon] = useState<QueryResult | null>(null);
  const [picked, setPicked] = useState<{ key: string; cost_type: string | null; item_key: string; label: string } | null>(null);
  const [drill, setDrill] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  const params = { project_key: projectKey, rows_by: rowsBy, source: source || null };

  useEffect(() => {
    if (!projectKey) { setKpi(null); setMonthly(null); return; }
    let live = true;
    (async () => {
      try {
        setError(null);
        const k = await call(api.queries.run('REG_KPI', { project_key: projectKey }));
        if (live) setKpi(k.rows[0] ?? null);
        const m = await call(api.queries.run('REG_MONTHLY', params));
        if (live) { setMonthly(m); setPicked(null); setLines(null); setRecon(null); }
      } catch (e) { if (live) setError((e as Error).message); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, dataVersion, rowsBy, source]);

  useEffect(() => {
    if (!projectKey || !picked) { setDrill(null); return; }
    let live = true;
    call(api.queries.run('REG_LINES', {
      ...params, cost_type: picked.cost_type == null ? null : `~${picked.cost_type}`, item_key: `~${picked.item_key}`,
    })).then((r) => { if (live) setDrill(r); }).catch((e) => setError((e as Error).message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  const exportBook = async () => {
    if (!projectKey) return;
    setBusy(true); setError(null); setSavedTo(null);
    try { setSavedTo(await call(api.register.exportReport(projectKey, rowsBy, source || null))); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (!projectKey) return <div className="card"><div className="empty">Select a project to see its actual cost register.</div></div>;
  const cur = project?.currency_code ?? '';
  const n = (k: string) => Number(kpi?.[k] ?? 0);

  return (
    <>
      {error && <div className="banner err">{error}</div>}
      {savedTo && <div className="banner ok">Saved to {savedTo} <button className="btn sm" onClick={() => api.showItem(savedTo)}>Show</button></div>}

      <div className="grid k4" style={{ marginBottom: 'var(--gutter)' }}>
        <div className="kpi"><div className="label">Actual to cut-off</div><div className="value">{money(n('actual_to_cutoff'), cur)}</div>
          <div className="delta">{n('lines').toLocaleString()} lines</div></div>
        <div className="kpi"><div className="label">Cut-off month{kpi?.report_month ? ` (${String(kpi.report_month)})` : ''}</div>
          <div className="value">{money(n('report_month_amount'), cur)}</div><div className="delta">Actual in the month</div></div>
        <div className="kpi"><div className="label">From detail sources</div><div className="value">{kpi?.from_detail_pct == null ? '—' : pct(n('from_detail_pct'))}</div>
          <div className="delta">Certificates, MB51, orders — the rest is CJI3</div></div>
        <div className="kpi"><div className="label">No work package</div><div className="value">{money(n('unallocated'), cur)}</div>
          <div className="delta">Code it on the Coding page</div></div>
      </div>

      <div className="card rpt-filter" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field"><span>Rows</span>
          <select value={rowsBy} onChange={(e) => setRowsBy(e.target.value as RowsBy)}>
            {(Object.keys(ROWS_LABEL) as RowsBy[]).map((k) => <option key={k} value={k}>{ROWS_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="field"><span>Source</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
        </label>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={exportBook} disabled={busy}
                title="Per month, Cumulative and Lines sheets, with the rows and source chosen here">
          {busy ? <span className="spinner" /> : '⤓'} Excel
        </button>
      </div>

      <SheetTabs sheets={[
        {
          id: 'month', label: 'Per month', content: () => (
            <div className="card">
              {!monthly ? <div className="empty">Loading…</div> : (
                <MonthPivot result={monthly} rowColumns={rowsBy === 'item' ? ['category', 'item', 'src', 'unit'] : ['category', 'item', 'src']}
                            keyColumns={['cost_type', 'item_key']}
                            colColumn="period_key" colOrderColumn="period_order" groupColumn="category"
                            columnLabels={{ item: rowsBy === 'item' ? 'Item' : ROWS_LABEL[rowsBy], src: 'Source', unit: 'Unit' }}
                            measures={rowsBy === 'item'
                              ? [{ key: 'amount', label: 'Amount', column: 'amount' }, { key: 'qty', label: 'Quantity', column: 'qty', noGroupTotals: true }]
                              : [{ key: 'amount', label: 'Amount', column: 'amount' }]}
                            totalFirst totalLabel={kpi?.report_month ? `Cumulative to ${String(kpi.report_month)}` : 'Cumulative'}
                            groupColor={categoryColor(monthly)}
                            startCollapsed highlightPeriod={kpi?.report_month ? String(kpi.report_month) : null}
                            selectedKey={picked?.key ?? null}
                            onRowClick={(r) => setPicked({
                              // MonthPivot's own row key: its row columns, then its key columns
                              key: [...(rowsBy === 'item' ? ['category', 'item', 'src', 'unit'] : ['category', 'item', 'src']), 'cost_type', 'item_key']
                                .map((c) => String(r[c] ?? '')).join(String.fromCharCode(1)),
                              cost_type: (r.cost_type as string | null) ?? null, item_key: String(r.item_key ?? ''),
                              label: `${String(r.category)} › ${String(r.item)}`,
                            })} />
              )}
              {picked && (
                <div style={{ marginTop: 14 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <h3 style={{ margin: 0 }}>{picked.label}</h3>
                    <button className="btn sm" onClick={() => setPicked(null)}>Close</button>
                  </div>
                  {drill ? <DataTable result={drill} signColumns={['amount']} maxHeight={360} /> : <div className="empty">Loading lines…</div>}
                </div>
              )}
            </div>
          ),
        },
        {
          id: 'lines', label: 'Lines', content: () => <LinesTab load={() => call(api.queries.run('REG_LINES', { ...params, cost_type: null, item_key: null }))}
                                                                  value={lines} set={setLines} />,
        },
        {
          id: 'sources', label: 'Sources check', content: () => (
            <div className="card">
              <p className="hint">
                Where a detail source is loaded it replaces that category's CJI3 lines. Each row compares the CJI3 amount set
                aside with the detail now counted; a difference is timing or cost not yet in the detail — the two are never added.
              </p>
              <LinesTab load={() => call(api.queries.run('COST_SOURCE_RECON', { project_key: projectKey }))} value={recon} set={setRecon} bare />
            </div>
          ),
        },
      ]} />
    </>
  );
}

/**
 * Each category in its cost type's own colour (dim_cost_type.color, set in Coding › Lists) — the same colour
 * its badge has everywhere else, fixed to the category, so a filter never repaints the rest.
 */
function categoryColor(result: QueryResult): (category: string) => string | undefined {
  const color = new Map<string, string>();
  for (const r of result.rows) if (r.category_color && !color.has(String(r.category))) color.set(String(r.category), String(r.category_color));
  return (category) => color.get(category);
}

/** A tab that fetches its table the first time it is opened. */
function LinesTab({ load, value, set, bare = false }: {
  load: () => Promise<QueryResult>; value: QueryResult | null; set: (r: QueryResult) => void; bare?: boolean;
}) {
  useEffect(() => { if (!value) load().then(set).catch(() => { /* shown as empty */ }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value]);
  const body = value ? <DataTable result={value} signColumns={['amount', 'difference']} maxHeight={560} /> : <div className="empty">Loading…</div>;
  return bare ? body : <div className="card">{body}</div>;
}
