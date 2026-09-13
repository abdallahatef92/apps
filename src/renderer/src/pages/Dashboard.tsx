import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { DataTable } from '../components/DataTable';
import { BarChart, LineChart } from '../components/Chart';
import { money, pct } from '../lib/format';
import type { QueryResult } from '@shared/types';

interface Freshness {
  report_name: string;
  module: string;
  source_system: string;
  latest_data_date: string | null;
  age_days: number | null;
  latest_rows: number | null;
  freshness_status: 'NO_DATA' | 'STALE' | 'CURRENT';
}

const STATUS_BADGE: Record<string, string> = { CURRENT: 'good', STALE: 'warn', NO_DATA: 'mute' };

export function Dashboard() {
  const { projectKey, project, dataVersion } = useApp();
  const [freshness, setFreshness] = useState<Freshness[]>([]);
  const [portfolio, setPortfolio] = useState<QueryResult | null>(null);
  const [curve, setCurve] = useState<QueryResult | null>(null);
  const [overruns, setOverruns] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        setFreshness(await call(api.freshness.list()) as Freshness[]);
        setPortfolio(await call(api.queries.run('PROJECT_SUMMARY', {})));
        if (projectKey) {
          setCurve(await call(api.queries.run('S_CURVE', { project_key: projectKey })));
          setOverruns(await call(api.queries.run('TOP_OVERRUNS', { project_key: projectKey, top_n: 10 })));
        } else {
          setCurve(null);
          setOverruns(null);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [projectKey, dataVersion]);

  const row = portfolio?.rows.find((r) => r.project_code === project?.project_code);
  const budget = Number(row?.budget_amount ?? 0);
  const actual = Number(row?.actual_amount ?? 0);
  const eac = Number(row?.eac_amount ?? 0);
  const vac = Number(row?.vac_amount ?? 0);
  // Without a budget there is nothing to vary from, so a variance would be a
  // fiction the size of the spend. Say so instead.
  const hasBudget = budget !== 0;
  const stale = freshness.filter((f) => f.freshness_status === 'STALE');
  const never = freshness.filter((f) => f.freshness_status === 'NO_DATA');

  return (
    <>
      {error && <div className="banner err">{error}</div>}

      {stale.length > 0 && (
        <div className="banner warn">
          <strong>{stale.length}</strong>&nbsp;of {freshness.length} data sources
          {stale.length === 1 ? ' has' : ' have'} gone stale — the figures below may not reflect the
          latest SAP position.
        </div>
      )}
      {stale.length === 0 && never.length > 0 && (
        <div className="banner info">
          {never.length} configured source{never.length === 1 ? ' has' : 's have'} never been
          loaded. Everything that has been loaded is current.
        </div>
      )}

      <div className="grid k4" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="label">Budget</div>
          <div className="value">{hasBudget ? money(budget, project?.currency_code ?? '') : '—'}</div>
          <div className="delta">{hasBudget ? 'Current approved version' : 'No budget loaded'}</div>
        </div>
        <div className="kpi">
          <div className="label">Actual to date</div>
          <div className="value">{money(actual, project?.currency_code ?? '')}</div>
          <div className="delta">{budget ? `${pct((actual / budget) * 100)} of budget` : 'No budget loaded'}</div>
        </div>
        <div className="kpi">
          <div className="label">EAC</div>
          <div className="value">{money(eac, project?.currency_code ?? '')}</div>
          <div className="delta">{eac === actual ? 'Actual only — no forecast loaded' : 'Actual + ETC'}</div>
        </div>
        <div className="kpi">
          <div className="label">Variance at completion</div>
          <div className={`value ${hasBudget ? (vac < 0 ? 'bad' : vac > 0 ? 'good' : '') : ''}`}>
            {hasBudget ? money(vac, project?.currency_code ?? '') : '—'}
          </div>
          <div className="delta">
            {hasBudget
              ? (vac < 0 ? 'Projected overrun' : 'Projected underrun')
              : 'Load a budget to measure variance'}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Data freshness</h3>
        <p className="hint">
          Every module records the as-of date of the report it came from. A number is only as
          trustworthy as the date beside it.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source report</th><th>Module</th><th>System</th>
                <th>Data date</th><th className="num">Age (days)</th>
                <th className="num">Rows</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {freshness.length === 0 && (
                <tr><td colSpan={7}><div className="empty">No source reports configured.</div></td></tr>
              )}
              {freshness.map((f) => (
                <tr key={f.report_name}>
                  <td>{f.report_name}</td>
                  <td><span className="badge mute">{f.module}</span></td>
                  <td className="faint">{f.source_system}</td>
                  <td className="mono">{f.latest_data_date ?? '—'}</td>
                  <td className="num">{f.age_days ?? '—'}</td>
                  <td className="num">{f.latest_rows?.toLocaleString() ?? '—'}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[f.freshness_status]}`}>
                      {f.freshness_status.replace('_', ' ')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {curve && curve.rows.length > 0 && (
        <div className="card">
          <h3>Cost S-curve</h3>
          <p className="hint">
            Cumulative position by period, computed in SQL. The forecast line continues the actual
            line, so where the two meet is today's cut-off.
          </p>
          <LineChart
            result={curve}
            xColumn="period_key"
            series={[
              { column: 'budget_cum', label: 'Budget' },
              { column: 'actual_cum', label: 'Actual (cum.)' },
              { column: 'forecast_cum', label: 'Actual + forecast (cum.)' },
            ]}
          />
        </div>
      )}

      {overruns && overruns.rows.length > 0 && (
        <div className="card">
          <h3>Top overruns</h3>
          <p className="hint">WBS elements where actual cost has already passed the current budget.</p>
          <BarChart result={overruns} labelColumn="wbs_name" valueColumn="overrun_amount" />
        </div>
      )}

      {portfolio && (
        <div className="card">
          <h3>Portfolio</h3>
          <p className="hint">One row per project. Empty columns simply mean that module has not been loaded yet.</p>
          <DataTable result={portfolio} maxHeight={300} signColumns={['vac_amount']} />
        </div>
      )}
    </>
  );
}
