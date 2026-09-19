import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { BarChart } from '../charts/BarChart';
import { DataTable } from '../components/DataTable';
import { KpiStrip } from '../components/KpiStrip';
import { SheetTabs } from '../components/SheetTabs';
import type { QueryResult } from '@shared/types';

/**
 * The "Summary" node of the user's real cost-report flow: source cost coded
 * into work packages, direct budget, accrual (cost incurred but not yet
 * posted in SAP) and indirect budget, converging on one headline. Every
 * number here is still a stored query's own result set — this page only
 * assembles PKG_SUMMARY / INDIRECT_SUMMARY / COST_REPORT_SUMMARY (and the
 * existing ACT_BY_COST_TYPE) into one screen.
 */
export function CostReport() {
  const { projectKey, project, dataVersion } = useApp();
  const [kpi, setKpi] = useState<QueryResult | null>(null);
  const [byCostType, setByCostType] = useState<QueryResult | null>(null);
  const [byPackage, setByPackage] = useState<QueryResult | null>(null);
  const [indirect, setIndirect] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        if (!projectKey) {
          setKpi(null); setByCostType(null); setByPackage(null); setIndirect(null);
          return;
        }
        const p = { project_key: projectKey };
        setKpi(await call(api.queries.run('COST_REPORT_SUMMARY', p)));
        setByCostType(await call(api.queries.run('ACT_BY_COST_TYPE', p)));
        setByPackage(await call(api.queries.run('PKG_SUMMARY', p)));
        setIndirect(await call(api.queries.run('INDIRECT_SUMMARY', p)));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [projectKey, dataVersion]);

  const unallocated = byPackage?.rows.find((r) => r.work_package === '(unallocated)');
  const unallocatedAmount = unallocated ? Number(unallocated.actual_amount ?? 0) + Number(unallocated.accrual_amount ?? 0) : 0;

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

      {unallocated && unallocatedAmount !== 0 && (
        <div className="banner warn">
          <strong>{project?.currency_code ?? ''} {unallocatedAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>{' '}
          of cost and accrual is not yet coded to a work package — see "Packages" below, or allocate it
          in Settings › Allocate work packages.
        </div>
      )}

      <SheetTabs sheets={[
        {
          id: 'overview', label: 'Overview', content: (
            <>
              {byCostType && byCostType.rows.length > 0 && (
                <div className="card">
                  <h3>Actual cost by cost type</h3>
                  <p className="hint">Material, subcontract, labor, equipment, indirect and other — the SAP-derived split.</p>
                  <BarChart result={byCostType} labelColumn="cost_type" valueColumn="actual_amount" />
                </div>
              )}
              {byPackage && byPackage.rows.length > 0 && (
                <div className="card">
                  <h3>Budget vs. committed by work package</h3>
                  <p className="hint">
                    Committed = actual cost + accrued cost, per work package. Negative variance means
                    committed has passed budget for that package.
                  </p>
                  <BarChart result={byPackage} labelColumn="work_package" valueColumn="variance_amount" diverging />
                </div>
              )}
            </>
          ),
        },
        {
          id: 'packages', label: 'Packages', content: byPackage && (
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3>Work package detail</h3>
                  <p className="hint">
                    Budget, actual and accrued cost per work package, with variance. The
                    "(unallocated)" row is cost no rule has coded yet — allocate it from
                    Settings › Allocate work packages.
                  </p>
                </div>
                <button className="btn sm" disabled={busy || !byPackage.rowCount}
                        onClick={exportTable(byPackage, 'Cost by work package',
                          'Budget vs. actual + accrued cost per work package.')}>
                  ⤓ Excel
                </button>
              </div>
              <DataTable result={byPackage} signColumns={['variance_amount']} />
            </div>
          ),
        },
        {
          id: 'indirect', label: 'Indirect', content: indirect && (
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3>Indirect cost vs. plan</h3>
                  <p className="hint">
                    Indirect cost is never coded to a work package, so this compares indirect
                    budget against indirect actual + accrued cost, per WBS.
                  </p>
                </div>
                <button className="btn sm" disabled={busy || !indirect.rowCount}
                        onClick={exportTable(indirect, 'Indirect cost vs. plan',
                          'Indirect budget vs. actual + accrued cost, per WBS.')}>
                  ⤓ Excel
                </button>
              </div>
              <DataTable result={indirect} signColumns={['variance_amount']} />
            </div>
          ),
        },
      ]} />
    </>
  );
}
