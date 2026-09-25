import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { BarChart } from '../charts/BarChart';
import { Treemap } from '../charts/Treemap';
import { LineChart } from '../charts/LineChart';
import { StackedColumnChart } from '../charts/StackedColumnChart';
import { DataTable } from '../components/DataTable';
import { KpiStrip } from '../components/KpiStrip';
import { SheetTabs } from '../components/SheetTabs';
import type { QueryResult } from '@shared/types';

/**
 * The subcontract picture for one project, assembled from stored queries:
 * the monthly service report's own views (SC_REPORT_KPI, SC_MONTH_BY_TRADE,
 * SC_TRADE_SUMMARY, SC_ACTIVE_SUBS_BY_MONTH, SC_TOP_SERVICES,
 * SC_QTY_RECONCILIATION, SC_CHECKS — the standalone ZSCPROG01 + ZSCSRV1
 * report, brought in) alongside the reconciliation against actual cost
 * (SC_BY_SUPPLIER, SC_BY_CATEGORY, SC_MONTHLY_TREND, SC_RECONCILIATION_STATUS,
 * SC_PO_RECONCILIATION, SC_INVOICE_RECONCILIATION). Every number is a stored
 * query's own result set.
 */
export function SubcontractorAnalysis() {
  const { projectKey, project, dataVersion } = useApp();
  const [kpi, setKpi] = useState<QueryResult | null>(null);
  const [byVendor, setByVendor] = useState<QueryResult | null>(null);
  const [byCategory, setByCategory] = useState<QueryResult | null>(null);
  const [trend, setTrend] = useState<QueryResult | null>(null);
  const [status, setStatus] = useState<QueryResult | null>(null);
  const [reconciliation, setReconciliation] = useState<QueryResult | null>(null);
  const [invoices, setInvoices] = useState<QueryResult | null>(null);
  const [byMonthTrade, setByMonthTrade] = useState<QueryResult | null>(null);
  const [byTrade, setByTrade] = useState<QueryResult | null>(null);
  const [activeSubs, setActiveSubs] = useState<QueryResult | null>(null);
  const [topServices, setTopServices] = useState<QueryResult | null>(null);
  const [qtyRecon, setQtyRecon] = useState<QueryResult | null>(null);
  const [checks, setChecks] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        if (!projectKey) {
          setKpi(null); setByVendor(null); setByCategory(null);
          setTrend(null); setStatus(null); setReconciliation(null); setInvoices(null);
          setByMonthTrade(null); setByTrade(null); setActiveSubs(null); setTopServices(null);
          setQtyRecon(null); setChecks(null);
          return;
        }
        const p = { project_key: projectKey };
        setKpi(await call(api.queries.run('SC_REPORT_KPI', p)));
        setByMonthTrade(await call(api.queries.run('SC_MONTH_BY_TRADE', p)));
        setByTrade(await call(api.queries.run('SC_TRADE_SUMMARY', p)));
        setActiveSubs(await call(api.queries.run('SC_ACTIVE_SUBS_BY_MONTH', p)));
        setTopServices(await call(api.queries.run('SC_TOP_SERVICES', p)));
        setQtyRecon(await call(api.queries.run('SC_QTY_RECONCILIATION', p)));
        setChecks(await call(api.queries.run('SC_CHECKS', p)));
        setByVendor(await call(api.queries.run('SC_BY_SUPPLIER', p)));
        setByCategory(await call(api.queries.run('SC_BY_CATEGORY', p)));
        setTrend(await call(api.queries.run('SC_MONTHLY_TREND', p)));
        setStatus(await call(api.queries.run('SC_RECONCILIATION_STATUS', p)));
        setReconciliation(await call(api.queries.run('SC_PO_RECONCILIATION', p)));
        setInvoices(await call(api.queries.run('SC_INVOICE_RECONCILIATION', p)));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [projectKey, dataVersion]);

  // SC_BY_SUPPLIER is already ordered by work_done_net DESC, so the first three
  // rows are the top three suppliers by construction — no re-sort needed here.
  const top3Share = byVendor && byVendor.rows.length > 0
    ? byVendor.rows.slice(0, 3).reduce((s, r) => s + Number(r.pct_of_total ?? 0), 0)
    : null;

  // Same idea for invoices: a count and value already computed in SQL
  // (not_yet_posted), just rolled up here rather than re-queried.
  const lagging = invoices ? invoices.rows.filter((r) => Number(r.not_yet_posted) === 1) : [];
  const laggingValue = lagging.reduce((s, r) => s + Number(r.certified_amount ?? 0), 0);

  // Count of checks needing attention — computed in SQL (needs_attention), only counted here.
  const failedChecks = checks ? checks.rows.filter((r) => Number(r.needs_attention) === 1).length : 0;

  const exportTable = (result: QueryResult | null, title: string, subtitle: string) => async () => {
    if (!result) return;
    setBusy(true); setError(null); setSavedTo(null);
    try {
      setSavedTo(await call(api.exportResult(result, {
        title, subtitle, context: { Project: project?.project_code },
      })));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      {error && <div className="banner err">{error}</div>}
      {savedTo && (
        <div className="banner ok">
          Exported to <span className="mono">{savedTo}</span>
          <button className="btn sm ghost" style={{ marginLeft: 10 }} onClick={() => api.showItem(savedTo)}>Show in folder</button>
        </div>
      )}

      {kpi && <KpiStrip headline={kpi} currency={project?.currency_code ?? ''} />}

      {top3Share !== null && (
        <div className="banner info">
          The top 3 suppliers account for <strong>{top3Share.toFixed(1)}%</strong> of certified subcontract work.
        </div>
      )}

      {lagging.length > 0 && (
        <div className="banner warn">
          <strong>{lagging.length}</strong> certificate{lagging.length === 1 ? '' : 's'} worth{' '}
          <strong>{laggingValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong> look
          {lagging.length === 1 ? 's' : ''} certified but not yet reflected in actual cost — see "PO
          vs invoice" below for which ones.
        </div>
      )}

      <SheetTabs sheets={[
        {
          id: 'overview', label: 'Overview', content: (
            <>
              {byMonthTrade && byMonthTrade.rows.length > 0 && (
                <div className="card">
                  <h3>Approved amount per month by trade</h3>
                  <p className="hint">
                    Approved certified value (net of VAT) per certificate month. Opening balances and lines
                    still pending approval are left out. The seven largest trades have their own colour;
                    the rest are folded into "Other trades".
                  </p>
                  <StackedColumnChart result={byMonthTrade} xColumn="period_key" seriesColumn="trade"
                    valueColumn="amount" orderColumn="series_order" otherLabel="Other trades" height={300} />
                </div>
              )}

              <div className="grid k2">
                {byTrade && byTrade.rows.length > 0 && (
                  <div className="card">
                    <h3>Subcontractors per trade</h3>
                    <p className="hint">Subcontractors with a non-zero total in each trade. One subcontractor can count in several trades.</p>
                    <BarChart result={byTrade} labelColumn="trade" valueColumn="subcontractors" />
                  </div>
                )}
                {activeSubs && activeSubs.rows.length > 0 && (
                  <div className="card">
                    <h3>Active subcontractors per month</h3>
                    <p className="hint">Subcontractors with a non-zero approved amount in the month.</p>
                    <StackedColumnChart result={activeSubs} xColumn="period_key"
                      valueColumn="active_subcontractors" valueLabel="Active subcontractors" height={240} />
                  </div>
                )}
              </div>

              {byTrade && byTrade.rows.length > 0 && (
                <div className="card">
                  <h3>Amount by trade</h3>
                  <p className="hint">Net of VAT. Trade comes from the service code (S0302 → 03 Concrete; L = labour supply, P = plant).</p>
                  <DataTable result={byTrade} />
                </div>
              )}

              {topServices && topServices.rows.length > 0 && (
                <div className="card">
                  <h3>Top 15 services</h3>
                  <p className="hint">
                    Qty and average rate come from normal lines only. A line whose amount is not qty × rate
                    counts at its equivalent qty (amount ÷ net rate). The amount includes adjustments.
                  </p>
                  <DataTable result={topServices} />
                </div>
              )}

              <div className="grid k2">
                {byVendor && byVendor.rows.length > 0 && (
                  <div className="card">
                    <h3>Certified work by supplier</h3>
                    <p className="hint">Net certified value per subcontractor, largest first.</p>
                    <BarChart result={byVendor} labelColumn="supplier" valueColumn="work_done_net" limit={8} />
                  </div>
                )}
                {byCategory && byCategory.rows.length > 0 && (
                  <div className="card">
                    <h3>Work by category</h3>
                    <p className="hint">Certified value by the work category named on the certificate.</p>
                    <Treemap result={byCategory} labelColumn="category" sizeColumn="work_done_net" height={280} />
                  </div>
                )}
              </div>

              {trend && trend.rows.length > 0 && (
                <div className="card">
                  <h3>Certified vs actual</h3>
                  <p className="hint">
                    Cumulative certified subcontract work against the matching actual cost (postings carrying
                    a PO). A gap that widens over time is a certificate not yet loaded, or cost posted ahead
                    of certification.
                  </p>
                  <LineChart result={trend} xColumn="period_key" height={280}
                    series={[
                      { column: 'actual_cum', label: 'Actual (PO postings, cum.)' },
                      { column: 'certified_cum', label: 'Certified (cum.)' },
                    ]} />
                </div>
              )}

              {status && status.rows.length > 0 && (
                <div className="card">
                  <h3>Reconciliation status</h3>
                  <p className="hint">How many purchase orders fall into each status, by count.</p>
                  <BarChart result={status} labelColumn="status" valueColumn="pos" />
                </div>
              )}
            </>
          ),
        },
        {
          id: 'qty', label: 'Qty reconciliation', content: qtyRecon && (
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3>Qty reconciliation per PO service line</h3>
                  <p className="hint">
                    One row per ZSCSRV1 PO service line. Certified qty is the certificate lines matched to it
                    (qty-only lines are shown separately). The difference is qty received − qty certified. When
                    it equals the qty-only lines it is explained by them; otherwise the row is flagged.
                    {qtyRecon.rowCount === 0 && ' No PO service lines (ZSCSRV1) are loaded for this project yet — upload one under "PO service lines".'}
                  </p>
                </div>
                <button className="btn sm" disabled={busy || !qtyRecon.rowCount}
                        onClick={exportTable(qtyRecon, 'Qty reconciliation',
                          'Qty received vs qty certified, per PO service line.')}>
                  ⤓ Excel
                </button>
              </div>
              <DataTable result={qtyRecon} signColumns={['difference']} flagColumn="unexplained"
                flagLabel="Received qty differs from certified qty and the qty-only lines do not explain it." />
            </div>
          ),
        },
        {
          id: 'checks', label: failedChecks ? `Checks (${failedChecks})` : 'Checks', content: checks && (
            <div className="card">
              <h3>Reconciliation and data checks</h3>
              <p className="hint">
                The latest certificate upload against SAP's own grand-total row. SAP repeats a certificate line
                once per WBS element it is charged to; those repeats are counted once and shown here, so
                footer − repeats − lines should be zero. If the file had no grand-total row the check reads
                "not checked", never "ok".
              </p>
              <DataTable result={checks} flagColumn="needs_attention" flagLabel="Needs attention." />
            </div>
          ),
        },
        {
          id: 'reconciliation', label: 'PO Reconciliation', content: reconciliation && (
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3>PO reconciliation detail</h3>
                  <p className="hint">
                    Every purchase order — actual cost against certified service-line value — sorted by
                    the size of its unreconciled gap. This is the "needs attention" list.
                  </p>
                </div>
                <button className="btn sm" disabled={busy || !reconciliation.rowCount}
                        onClick={exportTable(reconciliation, 'PO reconciliation',
                          'Actual cost vs certified service-line value, per purchase order.')}>
                  ⤓ Excel
                </button>
              </div>
              <DataTable result={reconciliation} signColumns={['difference']} />
            </div>
          ),
        },
        {
          id: 'invoices', label: 'PO vs Invoice', content: invoices && (
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3>PO vs invoice</h3>
                  <p className="hint">
                    Every certificate under every PO, in submission order, with its own certified value and
                    the running certified total for that PO. CJI3 is a batch extract and can lag the
                    certificate register by a cycle — when the running total passes what has actually been
                    posted for the PO, the newest certificate(s) causing that are flagged, not the whole PO.
                  </p>
                </div>
                <button className="btn sm" disabled={busy || !invoices.rowCount}
                        onClick={exportTable(invoices, 'PO vs invoice reconciliation',
                          'Certified value per certificate, running total per PO, against actual cost posted so far.')}>
                  ⤓ Excel
                </button>
              </div>
              <DataTable result={invoices} signColumns={[]} flagColumn="not_yet_posted"
                flagLabel="This certificate's running total for the PO is ahead of what CJI3 has posted so far — likely not yet reflected in actual cost." />
            </div>
          ),
        },
      ]} />
    </>
  );
}
