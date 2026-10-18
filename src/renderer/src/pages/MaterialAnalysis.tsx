import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { BarChart } from '../charts/BarChart';
import { Treemap } from '../charts/Treemap';
import { LineChart } from '../charts/LineChart';
import { StackedColumnChart } from '../charts/StackedColumnChart';
import { DataTable } from '../components/DataTable';
import { MonthPivot } from '../components/MonthPivot';
import { ReportFilterBar, type FilterDef } from '../components/ReportFilterBar';
import { KpiStrip } from '../components/KpiStrip';
import { SheetTabs, type Sheet } from '../components/SheetTabs';
import type { QueryResult } from '@shared/types';

type Row = Record<string, unknown>;
type Params = Record<string, unknown>;

/**
 * The material cost report. With MB51 loaded for the project it is the workbook's report, sheet by sheet,
 * as a native page (docs/port/native-report.md): a KPI strip, a filter bar that every tab follows, and
 * the sheets as tabs - each one a stored MAT_SHEET_* query rendered by DataTable / a chart, fetched when
 * its tab is first opened and again when a filter, the project or the data changes. Without MB51 the page
 * falls back to CJI3 material postings, assembled from stored queries as before.
 */

// ---------------------------------------------------------------------------------------------
// Query hook: one stored query, cached by (code, params, dataVersion); the previous result stays on
// screen while a new filter is running, so a tab never blanks out.
// ---------------------------------------------------------------------------------------------
const cache = new Map<string, QueryResult>();

function useQ(code: string, params: Params, version: number, enabled = true) {
  const key = `${code}|${JSON.stringify(params)}|${version}`;
  const [state, setState] = useState<{ key: string; data: QueryResult | null; error: string | null }>(
    { key: '', data: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const hit = cache.get(key);
    if (hit) { setState({ key, data: hit, error: null }); return; }
    (call(api.queries.run(code, params)) as Promise<QueryResult>)
      .then((r) => {
        if (cache.size > 300) cache.clear();
        cache.set(key, r);
        if (live) setState({ key, data: r, error: null });
      })
      .catch((e: Error) => { if (live) setState((s) => ({ key, data: s.data, error: e.message })); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return { data: state.data, error: state.error, loading: enabled && state.key !== key };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM' -> 'Mar 2026' */
const monthName = (pk: string): string => {
  const m = /^(\d{4})-(\d{2})/.exec(pk);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : pk;
};

/** A result with only some columns, in this order (for the KPI strip). */
function pickColumns(r: QueryResult, columns: string[]): QueryResult {
  return { ...r, columns, rows: r.rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c]]))) };
}

/** Columns whose group / total rows must not add up: rates, prices, percentages, quantities (mixed units), ages. */
const noSum = (r: QueryResult, extra: string[] = []): string[] =>
  r.columns.filter((c) => /(qty|rate|price|pct|age|spread|level|cumulative)/.test(c) || extra.includes(c));

function Loading({ on, error }: { on: boolean; error?: string | null }) {
  if (error) return <div className="banner err">{error}</div>;
  return on ? <div className="faint" style={{ fontSize: 12, margin: '0 0 8px' }}><span className="spinner" /> Updating…</div> : null;
}

// ---------------------------------------------------------------------------------------------
// Drill-down: the Data sheet's lines for one material (the workbook cannot do this)
// ---------------------------------------------------------------------------------------------
function DrillDown({ p, version, material, onClose }: {
  p: Params; version: number; material: { code: string; description: string }; onClose: () => void;
}) {
  const { data, loading, error } = useQ('MAT_SHEET_LINES', { ...p, material_code: `~${material.code}`, include_pending: 1 }, version);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [material.code]);
  return (
    <div className="card" ref={ref}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Issue lines · {material.code} <span className="faint">{material.description}</span></h3>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
      <p className="hint">Every MB51 issue line of this material under the current filter - pending lines included, with the reason.</p>
      <Loading on={loading} error={error} />
      {data && <DataTable result={data} signColumns={['qty', 'amount']} noSumColumns={noSum(data)} maxHeight={360} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// A table tab with a row-click drill-down
// ---------------------------------------------------------------------------------------------
function DrillTable({ result, p, version, signColumns, flagColumn, flagLabel, maxHeight = 560, groupByFamily = true, noSumExtra }: {
  result: QueryResult; p: Params; version: number; signColumns?: string[]; flagColumn?: string; flagLabel?: string; maxHeight?: number;
  groupByFamily?: boolean; noSumExtra?: string[];
}) {
  const [sel, setSel] = useState<Row | null>(null);
  // a new result (filter, project, data) replaces the rows, so the old selection no longer points into it
  const picked = sel && result.rows.includes(sel) ? sel : null;
  return (
    <>
      <p className="hint">Click a row to see its issue lines below.</p>
      <DataTable result={result} signColumns={signColumns} flagColumn={flagColumn} flagLabel={flagLabel}
                 defaultGroupBy={groupByFamily ? 'family' : undefined} keepGroupOrder noSumColumns={noSum(result, noSumExtra)}
                 onRowClick={(r) => setSel(r === picked ? null : r)} selectedRow={picked} maxHeight={maxHeight} />
      {picked && (
        <DrillDown p={p} version={version} onClose={() => setSel(null)}
                   material={{ code: String(picked.material_code ?? ''), description: String(picked.description ?? '') }} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------------------------
interface TabProps { p: Params; version: number; currency: string }

function SummaryTab({ p, version }: TabProps) {
  const [dim, setDim] = useState<'pkg' | 'family' | 'division'>('pkg');
  const type = useQ('MAT_SHEET_MONTH_TYPE', p, version);
  const table = useQ('MAT_SHEET_MONTH_TABLE', p, version);
  const by = useQ('MAT_SHEET_BY_DIM', { ...p, dim }, version);
  return (
    <>
      <Loading on={type.loading || table.loading || by.loading} error={type.error ?? table.error ?? by.error} />
      <div className="card">
        <h3>Cost per month</h3>
        <p className="hint">
          Issue cost per posting month, stacked by issue type: Project (221/222), To subcontractors (Z21/Z22, recoverable) and
          Scrap (551-556). Counted issues only - pending lines are in the tables below, not here.
        </p>
        {type.data && type.data.rows.length > 0
          ? <StackedColumnChart result={type.data} xColumn="period_key" valueColumn="amount" seriesColumn="issue_type"
                                orderColumn="series_order" height={260} />
          : type.data && <div className="empty">No counted issues under this filter.</div>}
        {table.data && table.data.rows.length > 0 && (
          <div style={{ marginTop: 14 }}><DataTable result={table.data} compact totalRow signColumns={['project', 'to_subcontractors', 'scrap', 'total']}
                     noSumColumns={noSum(table.data, ['materials', 'documents'])} maxHeight={320} /></div>
        )}
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Cost by {dim === 'pkg' ? 'work package' : dim}</h3>
          <div className="segmented">
            {([['pkg', 'Work package'], ['family', 'Family'], ['division', 'Division']] as const).map(([k, l]) => (
              <button key={k} className={dim === k ? 'on' : ''} onClick={() => setDim(k)}>{l}</button>
            ))}
          </div>
        </div>
        <p className="hint">
          Previous (months before the report month), This month, To date and Pending (never part of To date). Materials with no work
          package yet are one "(not coded)" line, so nothing is missing.
        </p>
        {by.data && <DataTable result={by.data} compact totalRow hiddenColumns={['sort_key']} signColumns={['previous', 'this_month', 'to_date', 'pending']}
                               noSumColumns={noSum(by.data)} maxHeight={420} />}
      </div>
    </>
  );
}

function CodingTab({ p, version, projectKey, onNavigate }: TabProps & { projectKey: number; onNavigate?: (page: 'packages') => void }) {
  const tree = useQ('MAT_COD_TREE', { project_key: projectKey }, version);
  const rows = useQ('MAT_SHEET_CODING', p, version);
  const total = tree.data?.rows.find((r) => Number(r.level) === 0);
  const coded = Number(total?.coded ?? 0), n = Number(total?.materials ?? 0);
  const done = n > 0 && coded === n;
  return (
    <>
      <Loading on={rows.loading} error={tree.error ?? rows.error} />
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <h3 style={{ margin: 0 }}>Coding status</h3>
            <p className="hint" style={{ marginTop: 6 }}>
              {total
                ? <><b>{coded.toLocaleString()}</b> of <b>{n.toLocaleString()}</b> materials are coded to a work package
                    ({Number(total.coded_pct ?? 0).toFixed(1)}%), {Number(total.to_code ?? 0).toLocaleString()} still to code.
                    The coding lives on the Work packages page and the report follows it at once.</>
                : 'No materials issued yet.'}
            </p>
            <div className="flow-meter" style={{ ['--c' as string]: done ? 'var(--good)' : 'var(--warning)' }}>
              <span style={{ width: `${n > 0 ? (coded / n) * 100 : 0}%` }} />
            </div>
          </div>
          {onNavigate && <button className="btn primary" onClick={() => onNavigate('packages')}>Code in Coding →</button>}
        </div>
      </div>
      {tree.data && tree.data.rows.length > 1 && (
        <div className="card">
          <h3>Still to code, by family › division › group</h3>
          <p className="hint">Start where the most is left: the whole project, not narrowed by the filter above.</p>
          <DataTable result={tree.data} compact noSumColumns={tree.data.columns} maxHeight={360} />
        </div>
      )}
      <div className="card">
        <h3>Materials</h3>
        <p className="hint">One row per material issued, in the SAP group tree order. Rows still to code are tinted; filter by Work package to list them.</p>
        {rows.data && <DataTable result={rows.data} defaultGroupBy="family" keepGroupOrder flagColumn="to_code" flagLabel="Still to code"
                                  signColumns={['to_date', 'this_month']} noSumColumns={noSum(rows.data, ['pos', 'suppliers'])} />}
      </div>
    </>
  );
}

function MaterialsTab({ p, version, currency }: TabProps) {
  const totals = useQ('MAT_SHEET_TOTALS', p, version);
  const rows = useQ('MAT_SHEET_MATERIALS', p, version);
  return (
    <>
      <Loading on={rows.loading} error={totals.error ?? rows.error} />
      {totals.data && <KpiStrip headline={totals.data} currency={currency} labels={{ materials: 'Materials' }} />}
      <div className="card">
        <h3>Material Summary</h3>
        <p className="hint">
          Previous / This month / To date as quantity, rate and amount; Pending is never part of To date. A rate change counts only when
          both rates are positive and within 3x - otherwise it reads "Check" (a unit mix-up, not a price change). The KPI row follows the
          filter. Use Group by (family, division, group) for the workbook's subtotals; subtotals of rate columns are not meaningful.
        </p>
        {rows.data && <DrillTable result={rows.data} p={p} version={version} noSumExtra={['start_month']}
                                  signColumns={['previous_amount', 'this_month_amount', 'to_date_amount', 'pending_amount', 'vs_previous_pct', 'vs_start_pct', 'vs_po_pct']} />}
      </div>
    </>
  );
}

function MonthTab({ p, version }: TabProps) {
  const rows = useQ('MAT_SHEET_MATERIAL_MONTH', p, version);
  // The query also returns a "To date" row per material; MonthPivot builds its own To date column, so those rows
  // are dropped here and the months get an order column (they are 'YYYY-MM', so text order is time order).
  const long = useMemo<QueryResult | null>(() => {
    if (!rows.data) return null;
    const kept = rows.data.rows.filter((r) => String(r.period) !== 'To date');
    const order = new Map([...new Set(kept.map((r) => String(r.period)))].sort().map((m, i) => [m, i]));
    return { ...rows.data, columns: [...rows.data.columns, 'col_order'],
             rows: kept.map((r) => ({ ...r, col_order: order.get(String(r.period)) ?? 0 })) };
  }, [rows.data]);
  return (
    <div className="card">
      <h3>Material per Month</h3>
      <p className="hint">One row per material, one column per month of counted issues, then To date, grouped by family. Rate is amount ÷ quantity (no total).</p>
      <Loading on={rows.loading} error={rows.error} />
      {long && (
        <MonthPivot result={long} rowColumns={['family', 'material_code', 'description', 'unit', 'pkg', 'division', 'material_group']}
                    colColumn="period" colOrderColumn="col_order" groupColumn="family"
                    columnLabels={{ pkg: 'PKG', material_code: 'Material' }}
                    measures={[
                      { key: 'amount', label: 'Amount', column: 'amount' },
                      { key: 'qty', label: 'Quantity', column: 'qty' },
                      { key: 'rate', label: 'Rate', ratio: ['amount', 'qty'] },
                    ]} />
      )}
    </div>
  );
}

function PoTab({ p, version }: TabProps) {
  const [view, setView] = useState<'lines' | 'materials'>('lines');
  const lines = useQ('MAT_SHEET_PO_REGISTER', p, version, view === 'lines');
  const mats = useQ('MAT_SHEET_PO_MATERIALS', p, version, view === 'materials');
  const cur = view === 'lines' ? lines : mats;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>PO Register</h3>
        <div className="segmented">
          <button className={view === 'lines' ? 'on' : ''} onClick={() => setView('lines')}>By PO line</button>
          <button className={view === 'materials' ? 'on' : ''} onClick={() => setView('materials')}>By material</button>
        </div>
      </div>
      <p className="hint">
        {view === 'lines'
          ? 'ME2N purchase lines as exported, deleted lines left out: ordered, delivered and open quantity, value, still to invoice, status, age of an open line at the cut date, price against the lowest PO price, and a flag (Open > 90 days, Price > 20% above the lowest, To invoice). The Month filter is the PO month. Click a line for its material\'s issue lines.'
          : 'One row per material: ordered, delivered and open, its PO prices (lowest, last, weighted, spread) and what MB51 issued to date - issued quantity, delivered minus issued, issue rate against the weighted PO price - and Committed = issued + still to deliver.'}
      </p>
      <Loading on={cur.loading} error={cur.error} />
      {cur.data && (
        <DrillTable result={cur.data} p={p} version={version}
                    signColumns={view === 'lines' ? ['vs_lowest_pct'] : ['delivered_minus_issued', 'vs_weighted_pct']}
                    noSumExtra={view === 'lines' ? ['order_qty'] : ['issued_qty', 'delivered_minus_issued']} />
      )}
    </div>
  );
}

function StoTab({ p, version }: TabProps) {
  const rows = useQ('MAT_SHEET_STO', p, version);
  return (
    <div className="card">
      <h3>Stores Transfers</h3>
      <p className="hint">
        Stock transport orders from own stores and plants (a plant-code supplier, no value, so not in the PO Register): ordered, delivered
        and open quantity, status, the age of an open line and Open &gt; 90 days. Click a line for its material's issue lines.
      </p>
      <Loading on={rows.loading} error={rows.error} />
      {rows.data && <DrillTable result={rows.data} p={p} version={version} />}
    </div>
  );
}

const CHECK_ROWS = ['unknown_mvt', 'outside', 'after_cut', 'no_date', 'zero_lines', 'z21', 'duplicates', 'no_group', 'multi_unit', 'negative_td', 'recon', 'old_po'];

function ChecksTab({ projectKey, version }: { projectKey: number; version: number }) {
  const checks = useQ('MAT_CHECKS', { project_key: projectKey }, version);
  const [sel, setSel] = useState<Row | null>(null);
  const picked = sel && checks.data?.rows.includes(sel) ? sel : null;
  const code = picked ? String(picked.check_code) : '';
  const hasRows = !!picked && CHECK_ROWS.includes(code) && Number(picked.lines) > 0;
  const rows = useQ('MAT_CHECK_ROWS', { project_key: projectKey, check_code: code }, version, hasRows);
  return (
    <>
      <div className="card">
        <h3>Checks</h3>
        <p className="hint">
          What to look at before sending the report. None of these changes a figure, and they cover the whole project - the filter does not
          apply. A file with no total row reads "not checked", never "ok". Click a check to list the lines behind it.
        </p>
        <Loading on={checks.loading} error={checks.error} />
        {checks.data && <DataTable result={checks.data} compact flagColumn="needs_attention" flagLabel="Needs a look" noSumColumns={checks.data.columns} maxHeight={420}
                                   onRowClick={(r) => setSel(r === picked ? null : r)} selectedRow={picked} />}
      </div>
      {picked && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{String(picked.check_name)}</h3>
            <button className="btn sm" onClick={() => setSel(null)}>Close</button>
          </div>
          <p className="hint">{String(picked.detail ?? '')}</p>
          {!hasRows
            ? <div className="empty">{CHECK_ROWS.includes(code) ? 'Nothing to list - no lines behind this check.' : 'This check has no line-level list.'}</div>
            : rows.data && <><Loading on={rows.loading} error={rows.error} /><DataTable result={rows.data} signColumns={['amount']} noSumColumns={noSum(rows.data)} maxHeight={360} /></>}
        </div>
      )}
    </>
  );
}

function LinesTab({ p, version }: TabProps) {
  const [pending, setPending] = useState(false);
  const rows = useQ('MAT_SHEET_LINES', { ...p, include_pending: pending ? 1 : null }, version);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Data · every issue line</h3>
        <label className="row" style={{ gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} />
          Include pending lines
        </label>
      </div>
      <p className="hint">
        One row per MB51 issue line that counts (cost = − SAP amount, so an issue is positive and a return negative), with the SAP-signed values
        beside it. Pending lines - posted after the cut-off, or with no posting date - are listed only when asked for, with the reason.
      </p>
      <Loading on={rows.loading} error={rows.error} />
      {rows.data && <DataTable result={rows.data} defaultGroupBy="family" keepGroupOrder signColumns={['qty', 'amount']}
                                  noSumColumns={noSum(rows.data)} maxHeight={600} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// How the figures are calculated (the workbook's Notes, in the app's words)
// ---------------------------------------------------------------------------------------------
function Method() {
  const item = (t: string, body: ReactNode) => <li style={{ marginBottom: 8 }}><b>{t}</b> {body}</li>;
  return (
    <details className="card">
      <summary style={{ cursor: 'pointer', fontWeight: 650 }}>How the figures are calculated</summary>
      <ul className="hint" style={{ paddingLeft: 18, marginTop: 12, lineHeight: 1.6 }}>
        {item('Cost and sign.', 'Cost = − SAP amount and quantity = − SAP quantity: SAP signs an issue negative (it leaves the stock) and a return positive, so here an issue is a positive cost and a return a negative one. Rate = amount ÷ quantity, the price the material was issued at.')}
        {item('What counts.', 'Goods issues to the project (221/222, and 281/282 for a network), issues to subcontractors with deduction (Z21/Z22 - project cost that should come back on the subcontractor\'s certificate) and scrapping (551-556). Every other movement - receipts, transfers, issues to orders or cost centres, subcontractor stock - is not project cost; the Checks tab lists them. Issues with no value (owner-supplied material, scrap at no price) are left out.')}
        {item('Periods.', 'The report month is the month of the project cut-off. This month = that month, Previous = every month before it, To date = Previous + This month. Pending = posted after the cut-off or with no posting date; it is shown but never added to To date. The cost of a month can still change after it was reported: an issue can be posted later with a date in that month.')}
        {item('Source.', 'Cost comes from MB51 material documents (the headline actual uses them in place of CJI3 material for this project). ME2N purchase lines are the reference: material group, unit, supplier, price, and what is still to be delivered. The material list (MM60) gives a group to materials ME2N does not have.')}
        {item('Grouping.', 'Every tab follows the SAP group tree: family (M Materials, P Plant & tools, SP Spare parts…) › division (M03 Concrete) › group (M030201 Steel Bars) › material. Families keep a fixed order; within them the largest To date comes first. Use Group by on a table for subtotals.')}
        {item('Coding.', 'The work package of a material is coded on the Work packages page, per project, and every tab follows it at once. A material not coded yet sits on one "(not coded)" line so nothing is missing. MNL is the code of the MATERIAL cost type.')}
        {item('Rate analysis.', 'This month vs previous compares this month\'s rate with the rate to last month; since the start compares the To date rate with the rate of the material\'s first month with a quantity; Value = quantity × the change. When two rates differ by more than 3x (or one is not positive) the row reads "Check" and is left out of the totals - a unit mix-up, not a price change. PO price is the weighted unit price of the material\'s purchase lines in ME2N; Above / Below flag more than 10% apart.')}
        {item('PO Register and Stores Transfers.', 'ME2N purchase lines (a value), deleted lines left out, with status (Open, Partly delivered, To invoice, Closed), the age of an open line at the cut date and a flag (Open > 90 days, Price > 20% above the lowest, To invoice - first that applies). Stock transport orders from own stores carry no value and sit on Stores Transfers. Committed = issued to date + still to deliver.')}
        {item('Filters.', 'The filter bar narrows every tab to a family, division, work package, month or search text. Month is the posting month of an issue line and the PO month of a PO line. The KPI strip, the coding tree and the Checks are the whole project.')}
        {item('Checks.', 'None of them changes a figure: the MB51 file\'s own total row against the loaded lines, repeated document lines, movement types the rules do not know, lines held back as Pending, materials without a group or in mixed units, a negative To date, and MB51 against CJI3 material cost.')}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------
export function MaterialAnalysis({ onNavigate }: { onNavigate?: (page: 'packages') => void }) {
  const { projectKey, project, dataVersion } = useApp();
  const cur = project?.currency_code ?? '';

  const [hasMb51, setHasMb51] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [headline, setHeadline] = useState<QueryResult | null>(null);
  const [options, setOptions] = useState<QueryResult | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  // CJI3 material (the fallback when no MB51 is loaded)
  const [kpi, setKpi] = useState<QueryResult | null>(null);
  const [byMaterial, setByMaterial] = useState<QueryResult | null>(null);
  const [byGl, setByGl] = useState<QueryResult | null>(null);
  const [byWbs, setByWbs] = useState<QueryResult | null>(null);
  const [byVendor, setByVendor] = useState<QueryResult | null>(null);
  const [trend, setTrend] = useState<QueryResult | null>(null);
  const [outliers, setOutliers] = useState<QueryResult | null>(null);
  const [returns, setReturns] = useState<QueryResult | null>(null);
  const [detail, setDetail] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const shownFor = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    if (shownFor.current !== projectKey) {
      setHasMb51(null); setHeadline(null); setOptions(null); setFilters({}); setSavedTo(null);
      setKpi(null); setByMaterial(null); setByGl(null); setByWbs(null);
      setByVendor(null); setTrend(null); setOutliers(null); setReturns(null); setDetail(null);
    }
    if (!projectKey) { shownFor.current = null; setLoading(false); return; }
    setLoading(true);
    (async () => {
      try {
        const p = { project_key: projectKey };
        const run = (code: string) => call(api.queries.run(code, p)) as Promise<QueryResult>;
        const src = await run('MAT_SOURCE');
        if (!live) return;
        const mb = Number(src.rows[0]?.has_mb51 ?? 0) === 1;
        setHasMb51(mb);
        if (mb) {
          const [k, o] = await Promise.all([run('MAT_KPI'), run('MAT_FILTER_OPTIONS')]);
          if (!live) return;
          setHeadline(k); setOptions(o);
          return;
        }
        const [k, m, g, w, ven, t, o, r, d] = await Promise.all([
          run('KPI_MATERIAL'), run('MATERIAL_BY_MATERIAL'), run('MATERIAL_BY_GL'), run('MATERIAL_BY_WBS'),
          run('MATERIAL_BY_VENDOR'), run('MATERIAL_MONTHLY_TREND'), run('MATERIAL_RATE_OUTLIERS'),
          run('MATERIAL_RETURNS'), run('MATERIAL_DETAIL'),
        ]);
        if (!live) return;
        setKpi(k); setByMaterial(m); setByGl(g); setByWbs(w); setByVendor(ven); setTrend(t);
        setOutliers(o); setReturns(r); setDetail(d);
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) { shownFor.current = projectKey; setLoading(false); }
      }
    })();
    return () => { live = false; };
  }, [projectKey, dataVersion]);

  const exportReport = async () => {
    if (!projectKey) return;
    setBusy(true); setError(null); setSavedTo(null);
    try { setSavedTo(await call(api.material.exportReport(projectKey))); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const banners = (
    <>
      {error && <div className="banner err">{error}</div>}
      {savedTo && (
        <div className="banner ok">
          Exported to <span className="mono">{savedTo}</span>
          <button className="btn sm ghost" style={{ marginLeft: 10 }} onClick={() => api.showItem(savedTo)}>Show in folder</button>
        </div>
      )}
    </>
  );

  // ---- the native report (MB51 loaded) ----
  const filterParams = useMemo<Params>(() => ({
    project_key: projectKey,
    family: filters.family || null, division: filters.division || null, pkg: filters.pkg || null,
    month: filters.month || null, q: (filters.q ?? '').trim() || null,
  }), [projectKey, filters]);
  const setFilter = (k: string, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const filterDefs = useMemo<FilterDef[]>(() => {
    const opts = (kind: string) => (options?.rows ?? []).filter((r) => r.kind === kind)
      .map((o) => ({ value: String(o.value), label: String(o.label) }));
    return [
      { key: 'q', label: 'Search', kind: 'text', placeholder: 'Material, description, group…' },
      { key: 'family', label: 'Family', kind: 'select', options: opts('family') },
      { key: 'division', label: 'Division', kind: 'select', options: opts('division') },
      { key: 'pkg', label: 'Work package', kind: 'select', options: opts('pkg') },
      { key: 'month', label: 'Month', kind: 'select', options: opts('month') },
    ];
  }, [options]);

  if (hasMb51 && projectKey) {
    const reportMonth = String(headline?.rows[0]?.report_month ?? '');
    const strip = headline && pickColumns(headline,
      ['previous', 'this_month', 'to_date', 'pending', 'materials_issued', 'documents']);
    const tab = { p: filterParams, version: dataVersion, currency: cur };
    const sheets: Sheet[] = [
      { id: 'summary', label: 'Summary', content: <SummaryTab {...tab} /> },
      { id: 'coding', label: 'Coding', content: <CodingTab {...tab} projectKey={projectKey} onNavigate={onNavigate} /> },
      { id: 'materials', label: 'Materials', content: <MaterialsTab {...tab} /> },
      { id: 'month', label: 'Materials by month', content: <MonthTab {...tab} /> },
      { id: 'po', label: 'PO register', content: <PoTab {...tab} /> },
      { id: 'sto', label: 'Stores transfers', content: <StoTab {...tab} /> },
      { id: 'checks', label: 'Checks', content: <ChecksTab projectKey={projectKey} version={dataVersion} /> },
      { id: 'lines', label: 'Lines', content: <LinesTab {...tab} /> },
    ];
    return (
      <>
        <div className="row" style={{ justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
          <p className="hint" style={{ margin: 0 }}>
            {reportMonth && <>This month = <b>{monthName(reportMonth)}</b> - the cut-off month. </>}
            {loading && <span className="spinner" />}
          </p>
          <button className="btn" onClick={exportReport} disabled={busy}
                  title="The monthly Material Cost Report workbook: live formulas, cut date on its Summary sheet, one sheet per view.">
            {busy ? <span className="spinner" /> : '⤓'} Excel report
          </button>
        </div>
        {banners}
        {strip && <KpiStrip headline={strip} currency={cur}
                            labels={{ materials_issued: 'Materials issued this month', documents: 'Issue documents this month' }} />}
        <ReportFilterBar filters={filterDefs} values={filters} onChange={setFilter} onClear={() => setFilters({})} />
        <SheetTabs sheets={sheets} />
        <Method />
      </>
    );
  }

  // ---- CJI3 material postings (the fallback, and the GL-level extras) ----
  const cjiOverview: Sheet = {
    id: 'overview', label: 'Overview', content: (
      <>
        <div className="grid k2">
          {byMaterial && byMaterial.rows.length > 0 && (
            <div className="card">
              <h3>Spend by material</h3>
              <p className="hint">
                Material cost rolled up per real material (SAP material number) — several
                different materials commonly share one GL account, so this is the true
                material identity, not the account it happens to post to.
              </p>
              <BarChart result={byMaterial} labelColumn="material_name" valueColumn="amount" limit={8} />
            </div>
          )}
          {byGl && byGl.rows.length > 0 && (
            <div className="card">
              <h3>Spend by GL</h3>
              <p className="hint">Material cost rolled up per account, largest first.</p>
              <BarChart result={byGl} labelColumn="cost_element_name" valueColumn="amount" limit={8} />
            </div>
          )}
          {byWbs && byWbs.rows.length > 0 && (
            <div className="card">
              <h3>Spend by WBS</h3>
              <p className="hint">Where the material money is going structurally.</p>
              <Treemap result={byWbs} labelColumn="wbs_name" sizeColumn="amount" codeColumn="wbs_code" height={280} />
            </div>
          )}
        </div>

        {trend && trend.rows.length > 0 && (
          <div className="card">
            <h3>Monthly trend</h3>
            <p className="hint">Material spend per month with a running cumulative total.</p>
            <LineChart result={trend} xColumn="period_key" height={280} area
              series={[{ column: 'period_amount', label: 'Spend in period' }]} />
          </div>
        )}

        {byVendor && byVendor.rows.length > 0 && (
          <div className="card">
            <h3>Spend by vendor</h3>
            <p className="hint">Supplier concentration reads the same way it does for subcontractors.</p>
            <BarChart result={byVendor} labelColumn="vendor_name" valueColumn="amount" limit={8} />
          </div>
        )}
      </>
    ),
  };
  const cjiSheets: Sheet[] = [
    {
      id: 'outliers', label: 'Rate Outliers', content: outliers && (
        <div className="card">
          <h3>Unit-rate outliers</h3>
          <p className="hint">
            Postings whose unit rate (amount ÷ quantity) is more than 5x its GL's own average rate —
            a likely pricing error, wrong unit of measure, or a purchase outside the usual supplier
            agreement. A GL needs at least 5 priced postings before the check applies.
          </p>
          <DataTable result={outliers} signColumns={['unit_rate', 'amount']} />
        </div>
      ),
    },
    {
      id: 'returns', label: 'Returns', content: returns && (
        <div className="card">
          <h3>Returns and damages</h3>
          <p className="hint">Material postings with a negative amount — returns, damages, or a credit against an earlier delivery.</p>
          <DataTable result={returns} signColumns={['amount']} />
        </div>
      ),
    },
    {
      id: 'detail', label: 'Detail', content: detail && (
        <div className="card">
          <h3>Material postings</h3>
          <p className="hint">Every material posting, most recent first.</p>
          <DataTable result={detail} signColumns={['amount']} />
        </div>
      ),
    },
  ];

  return (
    <>
      {banners}
      {projectKey && hasMb51 === false && (
        <div className="banner info">
          No MB51 loaded — figures below are CJI3 material postings. Load SAP MB51 (and ME2N) under Upload to get the
          monthly material cost report.
        </div>
      )}
      {kpi && <KpiStrip headline={kpi} currency={cur} />}
      {hasMb51 === false && <SheetTabs sheets={[cjiOverview, ...cjiSheets]} />}
    </>
  );
}
