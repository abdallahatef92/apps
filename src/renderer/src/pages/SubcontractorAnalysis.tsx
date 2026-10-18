import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import type { QueryResult } from '@shared/types';
import { SheetTabs } from '../components/SheetTabs';
import { KpiStrip } from '../components/KpiStrip';
import { DataTable } from '../components/DataTable';
import { MonthPivot, pivotRowKey } from '../components/MonthPivot';
import { ReportFilterBar, type FilterDef, type FilterOption } from '../components/ReportFilterBar';
import { StackedColumnChart } from '../charts/StackedColumnChart';
import { Heatmap } from '../charts/Heatmap';

/**
 * The subcontract cost report as a native page (docs/port/native-report.md): the workbook's sheets as tabs,
 * every figure a stored SC_* query, every tab following the same filter bar. A tab's queries run when it is
 * first opened and again when the filters, the project or the data change. Clicking a row of a summary table
 * opens the certificate lines behind it under the table.
 */

type TabId = 'summary' | 'coding' | 'services' | 'svcMonth' | 'po' | 'poMonth' | 'subs' | 'invoices' | 'checks' | 'changes' | 'lines';
type Data = Record<string, QueryResult>;
type Params = Record<string, unknown>;

const TABS: { id: TabId; label: string; filtered: boolean; queries: Record<string, string> }[] = [
  { id: 'summary', label: 'Summary', filtered: true, queries: {
    months: 'SC_SHEET_MONTHS', monthsTable: 'SC_SHEET_MONTHS_TABLE', div: 'SC_SHEET_DIV', tow: 'SC_SHEET_TOW', recon: 'SC_SAP_RECON' } },
  { id: 'coding', label: 'Coding', filtered: true, queries: { coding: 'SC_SHEET_CODING', status: 'SC_SHEET_CODING_STATUS' } },
  { id: 'services', label: 'Services', filtered: true, queries: { services: 'SC_SHEET_SERVICES' } },
  { id: 'svcMonth', label: 'Services by month', filtered: true, queries: { rows: 'SC_SHEET_SERVICE_MONTH' } },
  { id: 'po', label: 'PO register', filtered: true, queries: { rows: 'SC_SHEET_PO_REGISTER' } },
  { id: 'poMonth', label: 'PO by month', filtered: true, queries: { rows: 'SC_SHEET_PO_MONTH' } },
  { id: 'subs', label: 'Subcontractors', filtered: true, queries: { rows: 'SC_SHEET_SUBS' } },
  { id: 'invoices', label: 'Invoices register', filtered: true, queries: { rows: 'SC_INVOICES_REGISTER' } },
  { id: 'checks', label: 'Checks', filtered: false, queries: { checks: 'SC_CHECKS' } },
  { id: 'changes', label: 'Changes', filtered: true, queries: { summary: 'SC_CHANGES_SUMMARY', changes: 'SC_CHANGES' } },
  { id: 'lines', label: 'Lines', filtered: true, queries: { rows: 'SC_SHEET_LINES' } },
];

const FILTER_LISTS: Record<string, string> = { tow: 'SC_FILTER_TOW', vendor: 'SC_FILTER_VENDOR', pkg: 'SC_FILTER_PKG', month: 'SC_FILTER_MONTH' };

/** Columns whose sum means nothing in a subtotal: quantities, rates, shares, rate changes, distinct counts. */
const noSum = (r: QueryResult, extra: string[] = []): string[] =>
  r.columns.filter((c) => /(qty|rate|pct|change|cumulative)/.test(c) || extra.includes(c));

/** A text key sent to a stored query: the "~" keeps a numeric-looking value ('020212') a string. */
const key = (v: unknown) => (v === null || v === undefined || v === '' ? null : `~${String(v)}`);

interface Drill { title: string; params: Params; row: Record<string, unknown> }

const METHOD: { h: string; p: string[] }[] = [
  { h: 'Where the numbers come from', p: [
    'Certificate lines come from the SAP subcontractor report (ZSCPRG01), PO service lines from ZSCSRV1. Every figure on this page is a stored SQL query over those lines; the ⤓ Excel report is the same data with live formulas. The figures are net of VAT.',
    'A certificate is a PO plus its invoice serial, counted once. When SAP splits a certificate line over several WBS elements it repeats the line with the full amount on each; the repeats are counted once.'] },
  { h: 'Previous, This month, To date, Pending', p: [
    'The report month is the month of the project cut-off (else the latest month with data). Previous = Opening + the months before the report month; This month = the report month up to the cut date; To date = Previous + This month.',
    'Pending is never in To date: a line not approved yet (Character 1 is not X), without a certificate date, or dated after the cut date. The Summary table “From the SAP total to this report” walks from SAP\'s own grand total to To date.'] },
  { h: 'Line type, quantity and rate', p: [
    'Net rate = the gross price, or the gross price ÷ (1 + VAT rate) on an A2 contract (price includes VAT). A line is Normal when amount = SAP current quantity × net rate (within 1 EGP or 0.1%); anything else is an Adjustment — a paid-% change, a hold or its release, a reversal, a re-price.',
    'Qty: a Normal line keeps SAP\'s quantity. An Adjustment becomes quantity at the rate its PO line was certified at (Σ amount ÷ Σ quantity of the Normal lines of the same PO line; else its own net rate). Rate on every table = amount ÷ qty.'] },
  { h: 'Coding, type of works and units', p: [
    'DIV is the service\'s work package, coded on the Work packages page; services not coded yet are one “(not coded)” line, so the totals still tie. MNL is the Subcontract cost type\'s code. PKG and cost element are your own catalogue codes, which the app does not store (they are in the Excel report as empty columns).',
    'Type of works comes from each line\'s PO in ZSCSRV1; a service used on POs of different types is listed under its main type on the Services and Coding tabs (the PO register shows each PO). The unit comes from ZSCSRV1, else the service code suffix, else a unit word in the text.'] },
  { h: 'Rate analysis (Services tab)', p: [
    'This month vs previous: the previous rate (to last month) against this month\'s rate; value = this month\'s qty × the change. Since the start: the first month with quantity (Opening = the go-live invoice), its rate, the to-date rate, the change and value = to-date qty × the change.',
    'When two rates differ by more than 3 times (or one is not positive) the row reads “check” and is left out of every total: it is a placeholder price or another unit, not a price change.'] },
  { h: 'PO register', p: [
    'PO qty is the ZSCSRV1 quantity of the PO lines with that service and description. % of PO qty = To date qty ÷ PO qty. Status: “No PO line” (nothing matches in ZSCSRV1), “Over PO qty” (certified more than the PO holds), “Pending” (lines not in To date).'] },
  { h: 'Changes and checks', p: [
    'Changes compares the two latest certificate uploads line by line (new, amount changed, approved since, removed). A newly approved line counts at its full amount. Checks reconcile the latest upload with its own SAP footer and count each kind of line the report treats specially; “not checked” means there was nothing to compare against.'] },
];

export function SubcontractorAnalysis({ onNavigate }: { onNavigate?: (page: 'packages') => void }) {
  const { projectKey, dataVersion, cutoff } = useApp();
  const [tab, setTab] = useState<TabId>('summary');
  const [kpi, setKpi] = useState<QueryResult | null>(null);
  const [lists, setLists] = useState<Record<string, FilterOption[]>>({});
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [store, setStore] = useState<Record<string, { data?: Data; error?: string }>>({});
  const [drill, setDrill] = useState<Drill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const baseKey = `${projectKey}|${dataVersion}`;
  const lastBase = useRef(baseKey);
  const requested = useRef(new Set<string>());

  // Project / data change: forget everything fetched for the old one.
  useEffect(() => {
    if (lastBase.current === baseKey) return;
    lastBase.current = baseKey;
    requested.current = new Set();
    setStore({}); setDrill(null); setSavedTo(null);
  }, [baseKey]);
  useEffect(() => { setFilters({}); setKpi(null); }, [projectKey]);

  // Headline + the filter lists (independent of the filters themselves).
  useEffect(() => {
    let live = true;
    setError(null);
    if (!projectKey) { setKpi(null); setLists({}); return; }
    (async () => {
      try {
        const k = await call(api.queries.run('SC_REPORT_KPI', { project_key: projectKey })) as QueryResult;
        const l: Record<string, FilterOption[]> = {};
        for (const [name, code] of Object.entries(FILTER_LISTS)) {
          const r = await call(api.queries.run(code, { project_key: projectKey })) as QueryResult;
          l[name] = r.rows.map((x) => ({ value: String(x.value), label: String(x.label) }));
        }
        if (live) { setKpi(k); setLists(l); }
      } catch (e) { if (live) setError((e as Error).message); }
    })();
    return () => { live = false; };
  }, [projectKey, dataVersion]);

  const params: Params = useMemo(() => ({
    project_key: projectKey,
    tow: key(filters.tow), vendor: filters.vendor || null, pkg: key(filters.pkg),
    month: filters.month || null, q: filters.q || null,
  }), [projectKey, filters]);
  const filterKey = JSON.stringify([filters.tow, filters.vendor, filters.pkg, filters.month, filters.q]);

  const def = TABS.find((t) => t.id === tab)!;
  const storeKey = `${baseKey}|${def.filtered ? filterKey : ''}|${tab}`;
  const hasData = !!kpi && Number(kpi.rows[0]?.purchase_orders ?? 0) > 0;

  // A tab's queries run once per (project, data version, filters, tab).
  useEffect(() => {
    if (!projectKey || !hasData || requested.current.has(storeKey)) return;
    requested.current.add(storeKey);
    const base = baseKey;
    (async () => {
      try {
        const entries = await Promise.all(Object.entries(def.queries).map(async ([name, code]) =>
          [name, await call(api.queries.run(code, { ...params, roll_years: 0 })) as QueryResult] as const));
        if (lastBase.current === base) setStore((s) => ({ ...s, [storeKey]: { data: Object.fromEntries(entries) } }));
      } catch (e) {
        if (lastBase.current === base) setStore((s) => ({ ...s, [storeKey]: { error: (e as Error).message } }));
      }
    })();
  }, [storeKey, projectKey, hasData, def, params, baseKey]);

  useEffect(() => { setDrill(null); }, [tab, filterKey, baseKey]);

  const entry = store[storeKey];
  const setFilter = useCallback((k: string, v: string) => setFilters((f) => ({ ...f, [k]: v })), []);
  const filterDefs: FilterDef[] = [
    { key: 'q', label: 'Search', kind: 'text', placeholder: 'Service, subcontractor, PO…' },
    { key: 'tow', label: 'Type of works', kind: 'select', options: lists.tow },
    { key: 'vendor', label: 'Subcontractor', kind: 'select', options: lists.vendor },
    { key: 'pkg', label: 'DIV', kind: 'select', options: lists.pkg },
    { key: 'month', label: 'Month', kind: 'select', options: lists.month },
  ];

  const exportReport = async () => {
    if (!projectKey) return;
    setBusy(true); setError(null); setSavedTo(null);
    try { setSavedTo(await call(api.sc.exportReport(projectKey))); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const k = kpi?.rows[0];
  const monthLabel = (m: unknown) => lists.month?.find((o) => o.value === m)?.label ?? String(m ?? '');
  const headline = useMemo<QueryResult | null>(() => {
    if (!kpi || !k) return null;
    const cols = ['previous_amount', 'this_month_amount', 'to_date_amount', 'pending_amount', 'active_subs_month', 'certificates_month'];
    return { ...kpi, columns: cols, rows: [Object.fromEntries(cols.map((c) => [c, k[c]]))], rowCount: 1 };
  }, [kpi, k]);

  const tabProps: TabProps = { d: entry?.data, error: entry?.error, params, drill, setDrill, onNavigate };
  const render: Record<TabId, () => ReactNode> = {
    summary: () => <SummaryTab {...tabProps} />,
    coding: () => <CodingTab {...tabProps} />,
    services: () => <ServicesTab {...tabProps} />,
    svcMonth: () => <PivotTab {...tabProps} kind="svc" />,
    po: () => <PoTab {...tabProps} />,
    poMonth: () => <PivotTab {...tabProps} kind="po" />,
    subs: () => <SubsTab {...tabProps} />,
    invoices: () => <InvoicesTab {...tabProps} />,
    checks: () => <ChecksTab {...tabProps} />,
    changes: () => <ChangesTab {...tabProps} />,
    lines: () => <LinesTab {...tabProps} />,
  };

  return (
    <div>
      <div className="row" style={{ alignItems: 'baseline', marginBottom: 12, gap: 12 }}>
        <h2 style={{ margin: 0 }}>Subcontract Cost Report</h2>
        <span className="faint">
          {k ? <>This month = {monthLabel(k.report_month)}{cutoff?.cutoff_date ? ' — the cut-off month' : ' — the latest month with data'}</> : null}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" disabled={busy || !hasData} onClick={exportReport}
                title="The monthly Subcontract Cost Report workbook: live formulas and charts, one sheet per view.">
          {busy ? <span className="spinner" /> : '⤓'} Excel report
        </button>
      </div>
      {error && <div className="banner err">{error}</div>}
      {savedTo && (
        <div className="banner ok">
          Exported to <span className="mono">{savedTo}</span>
          <button className="btn sm ghost" style={{ marginLeft: 10 }} onClick={() => api.showItem(savedTo)}>Show in folder</button>
        </div>
      )}
      {!projectKey && <div className="card empty">Pick a project to see its subcontract cost report.</div>}
      {projectKey && kpi && !hasData && (
        <div className="card empty">No subcontract data for this project yet. Load the SAP subcontractor report (ZSCPROG01) under Upload.</div>
      )}
      {projectKey && !kpi && !error && <div className="card empty"><span className="spinner" /></div>}
      {hasData && headline && (
        <>
          <KpiStrip headline={headline} labels={{
            previous_amount: 'Previous (to last month)', this_month_amount: `This month · ${monthLabel(k?.report_month)}`,
            to_date_amount: 'To date', pending_amount: 'Pending – not in To date',
            active_subs_month: 'Active subcontractors this month', certificates_month: 'Certificates this month',
          }} sparkOn="to_date_amount" />
          <ReportFilterBar filters={filterDefs} values={filters} onChange={setFilter} onClear={() => setFilters({})}
                           busy={!entry} />
          <SheetTabs
            sheets={TABS.map((t) => ({ id: t.id, label: t.label, content: render[t.id] }))}
            activeId={tab} onActiveChange={(id) => setTab(id as TabId)} />
          <details className="card rpt-method">
            <summary>How the figures are calculated</summary>
            {METHOD.map((m) => (
              <div key={m.h}>
                <h4>{m.h}</h4>
                {m.p.map((t, i) => <p key={i} style={{ margin: '0 0 6px' }}>{t}</p>)}
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ tabs

interface TabProps {
  d?: Data;
  error?: string;
  params: Params;
  drill: Drill | null;
  setDrill: (d: Drill | null) => void;
  onNavigate?: (page: 'packages') => void;
}

function Loading({ p, children }: { p: TabProps; children: (d: Data) => ReactNode }) {
  if (p.error) return <div className="banner err">{p.error}</div>;
  if (!p.d) return <div className="card empty"><span className="spinner" /></div>;
  return <>{children(p.d)}</>;
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </div>
  );
}

/** The certificate lines behind the clicked row: SC_SHEET_LINES with the active filters plus the row's key. */
function DrillCard({ drill, params, onClose }: { drill: Drill; params: Params; onClose: () => void }) {
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sig = JSON.stringify([drill.params, params]);
  useEffect(() => {
    let live = true;
    setRes(null); setErr(null);
    call(api.queries.run('SC_SHEET_LINES', { ...params, ...drill.params }))
      .then((r) => { if (live) setRes(r as QueryResult); })
      .catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return (
    <div className="card rpt-drill">
      <div className="rpt-drill-head">
        <h3>{drill.title}</h3>
        <span className="faint">{res ? `${res.rowCount.toLocaleString()} certificate lines` : ''}</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={onClose}>Close ×</button>
      </div>
      {err ? <div className="banner err">{err}</div> : !res ? <span className="spinner" />
        : <DataTable result={res} maxHeight={380} signColumns={['amount']} />}
    </div>
  );
}

const withDrill = (p: TabProps) => p.drill && <DrillCard drill={p.drill} params={p.params} onClose={() => p.setDrill(null)} />;

function SummaryTab(p: TabProps) {
  return (
    <Loading p={p}>{(d) => (
      <>
        <Card title="1. Cost per month" hint="Certified value net of VAT per month by resource type (the first letter of the service code); Opening first, Pending not included.">
          <StackedColumnChart result={d.months} xColumn="month" xOrderColumn="sort_key" valueColumn="amount"
                              seriesColumn="resource" orderColumn="series_order" height={260} />
          <div style={{ marginTop: 14 }}>
            <DataTable result={d.monthsTable} compact totalRow hiddenColumns={['sort_key']}
                       noSumColumns={noSum(d.monthsTable, ['subcontractors'])} maxHeight={340} />
          </div>
        </Card>
        <Card title="2. Cost by DIV" hint="Follows the Coding tab: a service not coded yet is on the “(not coded)” line.">
          <DataTable result={d.div} compact totalRow noSumColumns={noSum(d.div)} maxHeight={320} />
        </Card>
        <Card title="3. Cost by type of works" hint="Each line takes its PO's type of works from ZSCSRV1.">
          <DataTable result={d.tow} compact totalRow noSumColumns={noSum(d.tow)} maxHeight={360} />
        </Card>
        <Card title="4. From the SAP total to this report" hint="The latest upload against its own grand-total row, then each kind of Pending.">
          <DataTable result={d.recon} compact maxHeight={300} />
        </Card>
      </>
    )}</Loading>
  );
}

function CodingTab(p: TabProps) {
  return (
    <Loading p={p}>{(d) => {
      const s = d.status.rows[0] ?? {};
      const total = Number(s.services ?? 0);
      const done = Number(s.coded_services ?? 0);
      return (
        <>
          <div className="card">
            <div className="row" style={{ gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <strong>{Number(s.services_to_code ?? 0).toLocaleString()}</strong> services still to code
                <span className="faint"> · {done.toLocaleString()} of {total.toLocaleString()} coded
                  {s.coded_pct_of_to_date !== null && s.coded_pct_of_to_date !== undefined ? ` · ${String(s.coded_pct_of_to_date)}% of To date` : ''}</span>
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div className={`rpt-meter${total > 0 && done === total ? ' done' : ''}`}>
                  <i style={{ width: `${total ? Math.round((100 * done) / total) : 0}%` }} />
                </div>
              </div>
              <div className="faint">
                Not coded: To date {fmtMoney(s.not_coded_to_date)} · this month {fmtMoney(s.not_coded_this_month)}
              </div>
              {p.onNavigate && <button className="btn primary" onClick={() => p.onNavigate!('packages')}>Code in Coding →</button>}
            </div>
          </div>
          <Card title="Coding status per service" hint="DIV is the service's work package; PKG and cost element are your own catalogue codes and are not stored in the app.">
            <DataTable result={d.coding} defaultGroupBy="type_of_works" keepGroupOrder flagColumn="not_coded" flagLabel="Not coded yet"
                       hiddenColumns={['service_code', 'service_norm']}
                       noSumColumns={noSum(d.coding, ['purchase_orders', 'subcontractors'])}
                       selectedRow={p.drill?.row} maxHeight={560}
                       onRowClick={(r) => p.setDrill({ title: `${r.service} · ${r.description}`, row: r,
                         params: { service_code: key(r.service_code), service_norm: key(r.service_norm) } })} />
          </Card>
          {withDrill(p)}
        </>
      );
    }}</Loading>
  );
}

function fmtMoney(v: unknown) {
  const n = Number(v ?? 0);
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

const SERVICES_LABELS: Record<string, string> = {
  previous_qty: 'Previous qty', previous_rate: 'Previous rate', previous_amount: 'Previous amount',
  month_qty: 'This month qty', month_rate: 'This month rate', month_amount: 'This month amount',
  todate_qty: 'To date qty', todate_rate: 'To date rate', todate_amount: 'To date amount',
  pending_qty: 'Pending qty', pending_rate: 'Pending rate', pending_amount: 'Pending amount',
  rate_previous: 'Rate · previous', rate_this_month: 'Rate · this month', rate_change: 'Rate · change',
  rate_change_pct: 'Rate · change %', rate_value: 'Rate · value', rate_status: 'Rate · status',
  first_month: 'Since start · first month', start_rate: 'Since start · start rate', start_to_date_rate: 'Since start · to date rate',
  start_change: 'Since start · change', start_change_pct: 'Since start · change %', start_value: 'Since start · value',
  start_status: 'Since start · status', div: 'DIV', mnl: 'MNL',
};

function ServicesTab(p: TabProps) {
  return (
    <Loading p={p}>{(d) => (
      <>
        <Card title="Service summary"
              hint="Previous, This month, To date and Pending per Service + Description, grouped by type of works, with the rate analysis on the right. Click a row for its certificate lines.">
          <DataTable result={d.services} defaultGroupBy="type_of_works" keepGroupOrder flagColumn="needs_check"
                     flagLabel="A rate pair is more than 3x apart or not positive: left out of the rate totals"
                     hiddenColumns={['service_code', 'service_norm']} columnLabels={SERVICES_LABELS}
                     noSumColumns={noSum(d.services)} signColumns={['rate_value', 'start_value']}
                     selectedRow={p.drill?.row} maxHeight={600}
                     onRowClick={(r) => p.setDrill({ title: `${r.service} · ${r.description}`, row: r,
                       params: { service_code: key(r.service_code), service_norm: key(r.service_norm) } })} />
        </Card>
        {withDrill(p)}
      </>
    )}</Loading>
  );
}

function PivotTab(p: TabProps & { kind: 'svc' | 'po' }) {
  const svc = p.kind === 'svc';
  const rowColumns = svc ? ['type_of_works', 'service', 'description', 'unit', 'div'] : ['type_of_works', 'po', 'subcontractor', 'service', 'description', 'unit', 'div'];
  const keyColumns = svc ? ['service_code', 'service_norm'] : ['po_no', 'service_code', 'service_norm'];
  return (
    <Loading p={p}>{(d) => (
      <>
        <Card title={svc ? 'Service per month' : 'PO per month'}
              hint={`${svc ? 'Service + Description' : 'PO + Service + Description'} by month, grouped by type of works. Opening is the go-live invoice; Pending is listed but not in To date. Click a row for its certificate lines.`}>
          <MonthPivot result={d.rows} rowColumns={rowColumns} keyColumns={keyColumns}
                      colColumn="period" colOrderColumn="col_order" groupColumn="type_of_works"
                      excludeFromTotal={['Pending']} columnLabels={{ div: 'DIV', po: 'PO' }}
                      measures={[
                        { key: 'amount', label: 'Amount', column: 'amount' },
                        { key: 'qty', label: 'Qty', column: 'qty' },
                        { key: 'rate', label: 'Rate', ratio: ['amount', 'qty'] },
                      ]}
                      selectedKey={p.drill ? pivotRowKey(p.drill.row, [...rowColumns, ...keyColumns]) : null}
                      onRowClick={(r) => p.setDrill({
                        title: svc ? `${r.service} · ${r.description}` : `PO ${r.po} · ${r.service} · ${r.description}`, row: r,
                        params: { service_code: key(r.service_code), service_norm: key(r.service_norm), ...(svc ? {} : { po_no: key(r.po_no) }) } })} />
        </Card>
        {withDrill(p)}
      </>
    )}</Loading>
  );
}

const PO_LABELS: Record<string, string> = {
  ...SERVICES_LABELS, po: 'PO', po_qty: 'PO qty (SAP)', pct_of_po_qty: '% of PO qty', certificates_all: 'Certificates (all)',
  last_certificate: 'Last cert. (all)',
};

function PoTab(p: TabProps) {
  return (
    <Loading p={p}>{(d) => (
      <>
        <Card title="PO register"
              hint="Every PO with its services: the ZSCSRV1 PO qty, what has been certified, and how much of the PO is used. Rows flagged have no PO line in ZSCSRV1 or are certified beyond the PO qty. Click a row for its certificate lines.">
          <DataTable result={d.rows} defaultGroupBy="type_of_works" keepGroupOrder flagColumn="needs_check"
                     flagLabel="No PO line in ZSCSRV1, or certified beyond the PO qty"
                     hiddenColumns={['po_no', 'service_code', 'service_norm', 'vendor_key']} columnLabels={PO_LABELS}
                     noSumColumns={noSum(d.rows, ['certificates_all'])}
                     selectedRow={p.drill?.row} maxHeight={600}
                     onRowClick={(r) => p.setDrill({ title: `PO ${r.po} · ${r.service} · ${r.description}`, row: r,
                       params: { po_no: key(r.po_no), service_code: key(r.service_code), service_norm: key(r.service_norm) } })} />
        </Card>
        {withDrill(p)}
      </>
    )}</Loading>
  );
}

function SubsTab(p: TabProps) {
  return (
    <Loading p={p}>{(d) => (
      <>
        <Card title="Subcontractor summary"
              hint="Per subcontractor, grouped by main type of works: certificates (PO + invoice serial, counted once) and amount for Previous, This month, To date and Pending. Click a row for its certificate lines.">
          <DataTable result={d.rows} defaultGroupBy="type_of_works" keepGroupOrder hiddenColumns={['vendor_key']}
                     columnLabels={{ purchase_orders: 'POs', pct_of_all: '% of all', todate_certificates: 'To date certificates',
                       todate_amount: 'To date amount', month_certificates: 'This month certificates', month_amount: 'This month amount',
                       previous_certificates: 'Previous certificates', previous_amount: 'Previous amount',
                       pending_certificates: 'Pending certificates', pending_amount: 'Pending amount' }}
                     noSumColumns={noSum(d.rows, ['purchase_orders'])}
                     selectedRow={p.drill?.row} maxHeight={600}
                     onRowClick={(r) => p.setDrill({ title: String(r.subcontractor ?? 'Subcontractor'), row: r,
                       params: { vendor: r.vendor_key ?? null } })} />
        </Card>
        {withDrill(p)}
      </>
    )}</Loading>
  );
}

function InvoicesTab(p: TabProps) {
  const [measure, setMeasure] = useState<'amount' | 'certificates'>('amount');
  return (
    <Loading p={p}>{(d) => (
      <Card title="Invoices register"
            hint="Certified volume per subcontractor and month — approved and dated up to the cut-off; Pending is not included. The first row is all subcontractors.">
        <div className="segmented" style={{ marginBottom: 12 }}>
          <button className={measure === 'amount' ? 'on' : ''} onClick={() => setMeasure('amount')}>Amount</button>
          <button className={measure === 'certificates' ? 'on' : ''} onClick={() => setMeasure('certificates')}>Certificates</button>
        </div>
        <Heatmap result={d.rows} rowColumn="vendor" colColumn="bucket" valueColumn={measure}
                 rowOrderColumn="row_order" colOrderColumn="col_order"
                 plainCols={['Opening', 'Previous years', 'To date']} plainRows={['All subcontractors']} />
      </Card>
    )}</Loading>
  );
}

function ChecksTab(p: TabProps) {
  const [sel, setSel] = useState<Record<string, unknown> | null>(null);
  const [rows, setRows] = useState<QueryResult | null>(null);
  const code = sel ? String(sel.check_code) : null;
  useEffect(() => {
    let live = true;
    setRows(null);
    if (!code) return;
    call(api.queries.run('SC_CHECK_ROWS', { project_key: p.params.project_key, check_code: code }))
      .then((r) => { if (live) setRows(r as QueryResult); }).catch(() => { if (live) setRows(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, p.params.project_key]);
  return (
    <Loading p={p}>{(d) => (
      <>
        <Card title="Checks" hint="Not filtered. Click a row to see the lines (or services) behind it — the 100 largest.">
          <DataTable result={d.checks} compact hiddenColumns={['check_code']} flagColumn="needs_attention"
                     flagLabel="Needs attention" noSumColumns={d.checks.columns} selectedRow={sel} maxHeight={520}
                     onRowClick={(r) => setSel(r)} />
        </Card>
        {sel && (
          <div className="card rpt-drill">
            <div className="rpt-drill-head">
              <h3>{String(sel.check)}</h3>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => setSel(null)}>Close ×</button>
            </div>
            {!rows ? <span className="spinner" /> : <DataTable result={rows} maxHeight={360} signColumns={['amount']} />}
          </div>
        )}
      </>
    )}</Loading>
  );
}

function ChangesTab(p: TabProps) {
  return (
    <Loading p={p}>{(d) => {
      const s = d.summary.rows[0] ?? {};
      return (
        <>
          {Number(s.loads ?? 0) < 2 && (
            <div className="banner">Only {Number(s.loads ?? 0)} certificate upload so far — there is nothing to compare yet.</div>
          )}
          <KpiStrip headline={{ ...d.summary, columns: ['new_lines', 'new_amount', 'changed_lines', 'changed_amount', 'newly_approved_lines',
            'newly_approved_amount', 'removed_lines', 'removed_amount'] }}
                    labels={{ new_lines: 'New lines', new_amount: 'New amount', changed_lines: 'Amount changed', changed_amount: 'Change',
                      newly_approved_lines: 'Approved since', newly_approved_amount: 'Newly approved amount',
                      removed_lines: 'Removed lines', removed_amount: 'Removed amount' }} />
          <Card title="Changes since the last load"
                hint="The two latest certificate uploads compared line by line. A newly approved line counts at its full amount. The search box filters this list; the other filters do not apply to it.">
            <DataTable result={d.changes} defaultGroupBy="change_type" keepGroupOrder signColumns={['difference']} maxHeight={520} />
          </Card>
        </>
      );
    }}</Loading>
  );
}

function LinesTab(p: TabProps) {
  return (
    <Loading p={p}>{(d) => (
      <Card title="Certificate lines"
            hint={`Every certificate line behind the report, counted and Pending, with the SAP figures each was derived from.${d.rows.rowCount >= 20000 ? ' Showing the first 20,000.' : ''}`}>
        <DataTable result={d.rows} signColumns={['amount']} maxHeight={640} />
      </Card>
    )}</Loading>
  );
}
