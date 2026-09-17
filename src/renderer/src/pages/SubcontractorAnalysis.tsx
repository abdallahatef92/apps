import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { BarChart } from '../charts/BarChart';
import { Treemap } from '../charts/Treemap';
import { LineChart } from '../charts/LineChart';
import { DataTable } from '../components/DataTable';
import { KpiStrip } from '../components/KpiStrip';
import type { QueryResult } from '@shared/types';

/**
 * Assembles queries that already existed (KPI_SUBCONTRACT, SC_BY_SUPPLIER,
 * SC_BY_CATEGORY, SC_PO_RECONCILIATION) with two new ones (SC_MONTHLY_TREND,
 * SC_RECONCILIATION_STATUS) into one screen, instead of picking them one at a
 * time in Analysis. Every number is still a stored query's own result set.
 */
export function SubcontractorAnalysis() {
  const { projectKey, project, dataVersion } = useApp();
  const [kpi, setKpi] = useState<QueryResult | null>(null);
  const [byVendor, setByVendor] = useState<QueryResult | null>(null);
  const [byCategory, setByCategory] = useState<QueryResult | null>(null);
  const [trend, setTrend] = useState<QueryResult | null>(null);
  const [status, setStatus] = useState<QueryResult | null>(null);
  const [reconciliation, setReconciliation] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        if (!projectKey) {
          setKpi(null); setByVendor(null); setByCategory(null);
          setTrend(null); setStatus(null); setReconciliation(null);
          return;
        }
        const p = { project_key: projectKey };
        setKpi(await call(api.queries.run('KPI_SUBCONTRACT', p)));
        setByVendor(await call(api.queries.run('SC_BY_SUPPLIER', p)));
        setByCategory(await call(api.queries.run('SC_BY_CATEGORY', p)));
        setTrend(await call(api.queries.run('SC_MONTHLY_TREND', p)));
        setStatus(await call(api.queries.run('SC_RECONCILIATION_STATUS', p)));
        setReconciliation(await call(api.queries.run('SC_PO_RECONCILIATION', p)));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [projectKey, dataVersion]);

  // SC_BY_SUPPLIER is already ordered by work_done_net DESC, so the first three
  // rows are the top three suppliers by construction — no re-sort needed here.
  const top3Share = byVendor && byVendor.rows.length > 0
    ? byVendor.rows.slice(0, 3).reduce((s, r) => s + Number(r.pct_of_total ?? 0), 0)
    : null;

  return (
    <>
      {error && <div className="banner err">{error}</div>}

      {kpi && <KpiStrip headline={kpi} currency={project?.currency_code ?? ''} />}

      {top3Share !== null && (
        <div className="banner info">
          The top 3 suppliers account for <strong>{top3Share.toFixed(1)}%</strong> of certified subcontract work.
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

      {reconciliation && (
        <div className="card">
          <h3>PO reconciliation detail</h3>
          <p className="hint">
            Every purchase order — actual cost against certified service-line value — sorted by the
            size of its unreconciled gap. This is the "needs attention" list.
          </p>
          <DataTable result={reconciliation} signColumns={['difference']} />
        </div>
      )}
    </>
  );
}
