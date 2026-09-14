import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { LineChart } from '../charts/LineChart';
import { BarChart } from '../charts/BarChart';
import { Treemap } from '../charts/Treemap';
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

export function Dashboard() {
  const { projectKey, project, dataVersion } = useApp();
  const [freshness, setFreshness] = useState<Freshness[]>([]);
  const [kpi, setKpi] = useState<QueryResult | null>(null);
  const [curve, setCurve] = useState<QueryResult | null>(null);
  const [trend, setTrend] = useState<QueryResult | null>(null);
  const [treemap, setTreemap] = useState<QueryResult | null>(null);
  const [heatmap, setHeatmap] = useState<QueryResult | null>(null);
  const [byType, setByType] = useState<QueryResult | null>(null);
  const [overruns, setOverruns] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        setFreshness(await call(api.freshness.list()) as Freshness[]);
        if (!projectKey) { setKpi(null); return; }
        const p = { project_key: projectKey };
        setKpi(await call(api.queries.run('KPI_PROJECT', p)));
        setCurve(await call(api.queries.run('S_CURVE', p)));
        setTrend(await call(api.queries.run('ACT_MONTHLY_TREND', p)));
        setTreemap(await call(api.queries.run('WBS_TREEMAP', { ...p, max_level: 3 })));
        setHeatmap(await call(api.queries.run('COST_HEATMAP', p)));
        setByType(await call(api.queries.run('ACT_BY_COST_TYPE', p)));
        setOverruns(await call(api.queries.run('TOP_OVERRUNS', { ...p, top_n: 10 })));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [projectKey, dataVersion]);

  const k = kpi?.rows[0] ?? {};
  const num = (key: string) => Number(k[key] ?? 0);
  const budget = num('budget'), actual = num('actual_cost'), revenue = num('revenue');
  const eac = num('eac'), vac = num('vac'), margin = num('margin');
  const hasBudget = budget !== 0;
  const cur = project?.currency_code ?? '';
  const sparkValues = trend?.rows.map((r) => Number(r.cumulative_amount ?? 0)) ?? [];

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
          {never.length} configured source{never.length === 1 ? ' has' : 's have'} never been loaded.
          Everything that has been loaded is current.
        </div>
      )}

      {/* ---------------- headline ---------------- */}
      <div className="grid k4" style={{ marginBottom: 16 }}>
        <div className="kpi" style={{ ['--kpi-accent' as string]: 'var(--series-1)' }}>
          <div className="label">Actual cost</div>
          <div className="value">{money(actual, cur)}</div>
          <div className="delta">
            {hasBudget ? `${pct((actual / budget) * 100)} of budget` : `${num('postings').toLocaleString()} postings`}
          </div>
          {sparkValues.length > 1 && <div className="spark"><Sparkline values={sparkValues} /></div>}
        </div>

        <div className="kpi" style={{ ['--kpi-accent' as string]: 'var(--series-3)' }}>
          <div className="label">Revenue billed</div>
          <div className="value">{money(revenue, cur)}</div>
          <div className="delta">
            {revenue ? `Margin ${money(margin, cur)}` : 'No income postings'}
          </div>
        </div>

        <div className="kpi" style={{ ['--kpi-accent' as string]: 'var(--series-4)' }}>
          <div className="label">Budget</div>
          <div className="value">{hasBudget ? money(budget, cur) : '—'}</div>
          <div className="delta">{hasBudget ? 'Current approved version' : 'No budget loaded'}</div>
        </div>

        <div className="kpi" style={{ ['--kpi-accent' as string]: hasBudget && vac < 0 ? 'var(--critical)' : 'var(--series-7)' }}>
          <div className="label">Variance at completion</div>
          <div className={`value ${hasBudget ? (vac < 0 ? 'bad' : vac > 0 ? 'good' : '') : ''}`}>
            {hasBudget ? money(vac, cur) : '—'}
          </div>
          <div className="delta">
            {hasBudget
              ? `EAC ${money(eac, cur)} · ${vac < 0 ? 'projected overrun' : 'projected underrun'}`
              : 'Load a budget to measure variance'}
          </div>
        </div>
      </div>

      {/* ---------------- curves ---------------- */}
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

      {treemap && treemap.rows.length > 0 && (
        <div className="card">
          <h3>Cost map by WBS</h3>
          <p className="hint">
            Area is actual cost; fill is variance against budget — red over, blue under, grey where
            there is no budget to compare against.
          </p>
          <Treemap result={treemap} labelColumn="wbs_name" sizeColumn="actual_amount"
                   colorColumn="variance_amount" codeColumn="wbs_code" height={330} />
        </div>
      )}

      {heatmap && heatmap.rows.length > 0 && (
        <div className="card">
          <h3>Spend by cost type and month</h3>
          <p className="hint">One hue, dark to light — the brighter the cell, the heavier the spend.</p>
          <Heatmap result={heatmap} rowColumn="cost_type" colColumn="period_key"
                   valueColumn="actual_amount" />
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
                      diverging limit={8} />
          </div>
        )}
      </div>

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
              {freshness.map((f) => (
                <tr key={f.report_name}>
                  <td>{f.report_name}</td>
                  <td><span className="badge mute plain">{f.module}</span></td>
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
    </>
  );
}
