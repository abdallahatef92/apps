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
 * Material has no PO sub-ledger the way subcontract does — it is just
 * cost_type = MATERIAL inside actual cost — so every query here is new,
 * unlike Subcontractor Analysis which mostly reuses existing ones.
 */
export function MaterialAnalysis() {
  const { projectKey, project, dataVersion } = useApp();
  const [kpi, setKpi] = useState<QueryResult | null>(null);
  const [byGl, setByGl] = useState<QueryResult | null>(null);
  const [byWbs, setByWbs] = useState<QueryResult | null>(null);
  const [byVendor, setByVendor] = useState<QueryResult | null>(null);
  const [trend, setTrend] = useState<QueryResult | null>(null);
  const [outliers, setOutliers] = useState<QueryResult | null>(null);
  const [returns, setReturns] = useState<QueryResult | null>(null);
  const [detail, setDetail] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        if (!projectKey) {
          setKpi(null); setByGl(null); setByWbs(null); setByVendor(null);
          setTrend(null); setOutliers(null); setReturns(null); setDetail(null);
          return;
        }
        const p = { project_key: projectKey };
        setKpi(await call(api.queries.run('KPI_MATERIAL', p)));
        setByGl(await call(api.queries.run('MATERIAL_BY_GL', p)));
        setByWbs(await call(api.queries.run('MATERIAL_BY_WBS', p)));
        setByVendor(await call(api.queries.run('MATERIAL_BY_VENDOR', p)));
        setTrend(await call(api.queries.run('MATERIAL_MONTHLY_TREND', p)));
        setOutliers(await call(api.queries.run('MATERIAL_RATE_OUTLIERS', p)));
        setReturns(await call(api.queries.run('MATERIAL_RETURNS', p)));
        setDetail(await call(api.queries.run('MATERIAL_DETAIL', p)));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [projectKey, dataVersion]);

  return (
    <>
      {error && <div className="banner err">{error}</div>}

      {kpi && <KpiStrip headline={kpi} currency={project?.currency_code ?? ''} />}

      <div className="grid k2">
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

      {outliers && outliers.rows.length > 0 && (
        <div className="card">
          <h3>Unit-rate outliers</h3>
          <p className="hint">
            Postings whose unit rate (amount ÷ quantity) is more than 5x its GL's own average rate —
            a likely pricing error, wrong unit of measure, or a purchase outside the usual supplier
            agreement. A GL needs at least 5 priced postings before the check applies.
          </p>
          <DataTable result={outliers} signColumns={['unit_rate', 'amount']} />
        </div>
      )}

      {returns && returns.rows.length > 0 && (
        <div className="card">
          <h3>Returns and damages</h3>
          <p className="hint">Material postings with a negative amount — returns, damages, or a credit against an earlier delivery.</p>
          <DataTable result={returns} signColumns={['amount']} />
        </div>
      )}

      {detail && (
        <div className="card">
          <h3>Material postings</h3>
          <p className="hint">Every material posting, most recent first.</p>
          <DataTable result={detail} signColumns={['amount']} />
        </div>
      )}
    </>
  );
}
