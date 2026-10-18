import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { LineChart } from '../charts/LineChart';
import { BarChart } from '../charts/BarChart';
import { Heatmap } from '../charts/Heatmap';
import { Sparkline } from '../charts/Sparkline';
import { money, pct } from '../lib/format';
import type { QueryResult } from '@shared/types';

interface Freshness {
  report_name: string; module: string; source_system: string;
  latest_data_date: string | null; age_days: number | null; latest_rows: number | null;
  freshness_status: 'NO_DATA' | 'STALE' | 'CURRENT';
}

const STATUS_BADGE: Record<string, string> = { CURRENT: 'good', STALE: 'warn', NO_DATA: 'mute' };

/** Project dashboard: headline KPIs, charts and data freshness. The build status lives on Home. */
export function Dashboard() {
  const { projectKey, project, dataVersion } = useApp();
  const [freshness, setFreshness] = useState<Freshness[]>([]);
  const [flow, setFlow] = useState<QueryResult | null>(null);
  const [kpi, setKpi] = useState<QueryResult | null>(null);
  const [curve, setCurve] = useState<QueryResult | null>(null);
  const [trend, setTrend] = useState<QueryResult | null>(null);
  const [heatmap, setHeatmap] = useState<QueryResult | null>(null);
  const [byType, setByType] = useState<QueryResult | null>(null);
  const [overruns, setOverruns] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        setFreshness(await call(api.freshness.list()) as Freshness[]);
        if (!projectKey) { setKpi(null); setFlow(null); return; }
        const p = { project_key: projectKey };
        setFlow(await call(api.queries.run('FLOW_STATUS', p)));
        setKpi(await call(api.queries.run('KPI_PROJECT', p)));
        setCurve(await call(api.queries.run('S_CURVE', p)));
        setTrend(await call(api.queries.run('ACT_MONTHLY_TREND', p)));
        setHeatmap(await call(api.queries.run('COST_HEATMAP', p)));
        setByType(await call(api.queries.run('ACT_BY_COST_TYPE', p)));
        setOverruns(await call(api.queries.run('TOP_OVERRUNS', { ...p, top_n: 10 })));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [projectKey, dataVersion]);

  const f = flow?.rows[0] ?? {};
  const fnum = (key: string) => Number(f[key] ?? 0);
  const k = kpi?.rows[0] ?? {};
  const budget = fnum('budget') || Number(k.budget ?? 0);
  const actualToCutoff = fnum('actual_to_cutoff');
  const cutoffDate = (f.cutoff_date as string | null) ?? null;
  const staleSources = fnum('stale_sources'), totalSources = fnum('total_sources');
  const hasBudget = budget !== 0;
  const cur = project?.currency_code ?? '';
  const sparkValues = trend?.rows.map((r) => Number(r.cumulative_amount ?? 0)) ?? [];

  return (
    <>
      {error && <div className="banner err">{error}</div>}
      {staleSources > 0 && (
        <div className="banner warn">
          <strong>{staleSources}</strong>&nbsp;of {totalSources} data sources
          {staleSources === 1 ? ' has' : ' have'} gone stale — the figures below may not reflect the
          latest SAP position.
        </div>
      )}

      {/* ---------------- headline ---------------- */}
      <div className="grid k4" style={{ marginBottom: 'var(--gutter)' }}>
        <div className="kpi" style={{ ['--kpi-accent' as string]: 'var(--accent-2)' }}>
          <div className="label">Budget</div>
          <div className="value">{hasBudget ? money(budget, cur) : '—'}</div>
          <div className="delta">{hasBudget ? 'Current approved version' : 'No budget loaded'}</div>
        </div>
        <div className="kpi" style={{ ['--kpi-accent' as string]: 'var(--accent-2)' }}>
          <div className="label">Actual to cut-off</div>
          <div className="value">{money(actualToCutoff, cur)}</div>
          <div className="delta">{cutoffDate ? `Through ${cutoffDate}` : 'All postings'}</div>
          {sparkValues.length > 1 && <div className="spark"><Sparkline values={sparkValues} /></div>}
        </div>
        <div className="kpi" style={{ ['--kpi-accent' as string]: 'var(--accent-2)' }}>
          <div className="label">Actual in cut-off month</div>
          <div className="value">{money(fnum('actual_cutoff_month'), cur)}</div>
          <div className="delta">{cutoffDate ? 'Month of the cut-off' : 'Latest period'}</div>
        </div>
        <div className="kpi" style={{ ['--kpi-accent' as string]: 'var(--accent-2)' }}>
          <div className="label">% of budget spent</div>
          <div className="value">{hasBudget ? pct((actualToCutoff / budget) * 100) : '—'}</div>
          <div className="delta">
            {hasBudget ? `${money(actualToCutoff, cur)} of ${money(budget, cur)}` : 'Load a budget to compare'}
          </div>
        </div>
      </div>

      {/* ---------------- charts ---------------- */}
      {curve && curve.rows.length > 0 && (
        <div className="card">
          <h3>Cost S-curve</h3>
          <p className="hint">
            Cumulative position by period over what was spent in each month, computed in SQL. The
            columns share the x axis but keep their own scale — monthly spend and a running total
            differ by too much to share one.
          </p>
          <LineChart result={curve} xColumn="period_key" height={390}
            series={[
              { column: 'budget_cum', label: 'Budget' },
              { column: 'actual_cum', label: 'Actual (cum.)' },
              { column: 'forecast_cum', label: 'Actual + forecast' },
            ]}
            bars={{ column: 'actual_period', label: 'Actual in month', seriesIndex: 1 }} />
        </div>
      )}

      <div className="grid k2">
        {byType && byType.rows.length > 0 && (
          <div className="card">
            <h3>Cost by type</h3>
            <p className="hint">Where the money goes.</p>
            <BarChart result={byType} labelColumn="cost_type" valueColumn="actual_amount" limit={8} />
          </div>
        )}
        {overruns && overruns.rows.length > 0 && (
          <div className="card">
            <h3>Top overruns</h3>
            <p className="hint">WBS elements already past their budget.</p>
            <BarChart result={overruns} labelColumn="wbs_name" valueColumn="overrun_amount"
                      color="var(--div-neg)" limit={8} />
          </div>
        )}
      </div>

      {heatmap && heatmap.rows.length > 0 && (
        <div className="card">
          <h3>Spend by cost type and month</h3>
          <p className="hint">One hue, dark to light — the brighter the cell, the heavier the spend.</p>
          <Heatmap result={heatmap} rowColumn="cost_type" colColumn="period_key"
                   valueColumn="actual_amount" />
        </div>
      )}

      {/* ---------------- freshness ---------------- */}
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
                <th>Source report</th><th>Module</th><th>System</th><th>Data date</th>
                <th className="num">Age (days)</th><th className="num">Rows</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {freshness.length === 0 && (
                <tr><td colSpan={7}><div className="empty">No source reports configured.</div></td></tr>
              )}
              {freshness.map((x) => (
                <tr key={x.report_name}>
                  <td>{x.report_name}</td>
                  <td><span className="badge mute plain">{x.module}</span></td>
                  <td className="faint">{x.source_system}</td>
                  <td className="mono">{x.latest_data_date ?? '—'}</td>
                  <td className="num">{x.age_days ?? '—'}</td>
                  <td className="num">{x.latest_rows?.toLocaleString() ?? '—'}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[x.freshness_status]}`}>
                      {x.freshness_status.replace('_', ' ')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
