import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { DataTable } from '../components/DataTable';
import { KpiStrip } from '../components/KpiStrip';
import { VizPanel, vizRenders } from '../components/VizPanel';
import { Pivot } from '../components/Pivot';
import type { QueryResult, StoredQuery, VizSpec } from '@shared/types';

interface ParamDef { name: string; type: string; label: string; required?: boolean; default?: string | number }

const SIGN_COLUMNS = ['variance_amount', 'vac_amount', 'overrun_amount', 'difference', 'margin', 'margin_cum'];
const MODULE_LABEL: Record<string, string> = {
  ACTUAL: 'Cost', CROSS: 'Comparison', FORECAST: 'Forecast', SERVICE: 'Subcontract', BUDGET: 'Budget',
};

type Tab = 'chart' | 'table' | 'sql';

export function Analysis() {
  const { projectKey, project, dataVersion } = useApp();
  const [queries, setQueries] = useState<StoredQuery[]>([]);
  const [code, setCode] = useState<string>('BVA_BY_WBS');
  const [pivotMode, setPivotMode] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QueryResult | null>(null);
  const [headline, setHeadline] = useState<QueryResult | null>(null);
  const [spark, setSpark] = useState<number[]>([]);
  const [tab, setTab] = useState<Tab>('chart');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  useEffect(() => {
    call(api.queries.list())
      .then((q) => setQueries((q as StoredQuery[])
        .filter((x) => x.module !== 'ADMIN' && x.category !== 'Headline')))
      .catch((e) => setError((e as Error).message));
  }, []);

  const query = useMemo(() => queries.find((q) => q.code === code), [queries, code]);
  const viz: VizSpec = useMemo(() => {
    try { return query ? JSON.parse(query.viz_json || '{}') : {}; } catch { return {}; }
  }, [query]);
  const paramDefs: ParamDef[] = useMemo(() => {
    try { return query ? JSON.parse(query.params_json) : []; } catch { return []; }
  }, [query]);

  const effective = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const p of paramDefs) {
      out[p.name] = p.type === 'project'
        ? (params[p.name] ?? projectKey ?? '')
        : (params[p.name] ?? p.default ?? '');
    }
    return out;
  }, [paramDefs, params, projectKey]);

  const run = async () => {
    if (!query) return;
    setBusy(true); setError(null); setSavedTo(null);
    try {
      const main = await call(api.queries.run(query.code, effective)) as QueryResult;
      setResult(main);
      setTab(vizRenders(main, viz) ? 'chart' : 'table');

      if (viz.headline && projectKey) {
        setHeadline(await call(api.queries.run(viz.headline, { project_key: projectKey })) as QueryResult);
        const trend = await call(api.queries.run('ACT_MONTHLY_TREND', { project_key: projectKey })) as QueryResult;
        setSpark(trend.rows.map((r) => Number(r.cumulative_amount ?? 0)));
      } else {
        setHeadline(null); setSpark([]);
      }
    } catch (e) {
      setError((e as Error).message); setResult(null); setHeadline(null);
    } finally { setBusy(false); }
  };

  useEffect(() => { if (query && !pivotMode) run(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, projectKey, dataVersion, queries.length, pivotMode]);

  const exportXlsx = async () => {
    if (!result || !query) return;
    setBusy(true); setError(null);
    try {
      setSavedTo(await call(api.exportResult(result, {
        title: query.name, subtitle: query.description ?? '',
        context: { Project: project?.project_code, ...effective },
      })));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const groups = useMemo(() => {
    const filter = search.trim().toLowerCase();
    const shown = filter
      ? queries.filter((q) => `${q.name} ${q.description ?? ''} ${q.category ?? ''}`
          .toLowerCase().includes(filter))
      : queries;
    const map = new Map<string, StoredQuery[]>();
    for (const q of shown) {
      const key = MODULE_LABEL[q.module] ?? q.module;
      map.set(key, [...(map.get(key) ?? []), q]);
    }
    return [...map.entries()];
  }, [queries, search]);

  return (
    <div className="split">
      {/* ---------------- rail ---------------- */}
      <div className="card" style={{ position: 'sticky', top: 0,
             maxHeight: 'calc(100vh - 104px)', overflow: 'auto', padding: '13px 11px' }}>
        <input placeholder="Search analyses…" value={search} style={{ width: '100%', marginBottom: 10 }}
               onChange={(e) => setSearch(e.target.value)} />

        <button className={`nav-item ${pivotMode ? 'active' : ''}`} onClick={() => setPivotMode(true)}>
          <span className="glyph">⊞</span> Pivot builder
        </button>

        {groups.map(([label, list]) => (
          <div key={label}>
            <div className="nav-group" style={{ padding: '0 10px' }}>{label}</div>
            {list.map((q) => (
              <button key={q.code} title={q.description ?? ''}
                      className={`nav-item ${!pivotMode && code === q.code ? 'active' : ''}`}
                      onClick={() => { setPivotMode(false); setCode(q.code); setParams({}); }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.name}
                </span>
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <div className="empty" style={{ padding: 20 }}>Nothing matches.</div>}
      </div>

      {/* ---------------- canvas ---------------- */}
      <div>
        {error && <div className="banner err">{error}</div>}
        {savedTo && (
          <div className="banner ok">
            Exported to <span className="mono">{savedTo}</span>
            <button className="btn sm ghost" style={{ marginLeft: 10 }}
                    onClick={() => api.showItem(savedTo)}>Show in folder</button>
          </div>
        )}

        {pivotMode ? (
          <Pivot onError={setError} />
        ) : !query ? (
          <div className="card"><div className="empty">Pick an analysis.</div></div>
        ) : (
          <>
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ maxWidth: 620 }}>
                  <h3 style={{ fontSize: 16 }}>{query.name}</h3>
                  <p className="hint" style={{ marginBottom: 0 }}>{query.description}</p>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn" onClick={run} disabled={busy}>
                    {busy ? <span className="spinner" /> : '↻'} Refresh
                  </button>
                  <button className="btn" onClick={exportXlsx} disabled={busy || !result?.rowCount}>
                    ⤓ Excel
                  </button>
                </div>
              </div>

              {paramDefs.filter((p) => p.type !== 'project').length > 0 && (
                <div className="row" style={{ marginTop: 14 }}>
                  {paramDefs.filter((p) => p.type !== 'project').map((p) => (
                    <label className="field" key={p.name}>
                      <span>{p.label}</span>
                      <input style={{ width: p.type === 'int' ? 90 : 130 }}
                             placeholder={p.type === 'period' ? 'YYYY-MM' : ''}
                             value={params[p.name] ?? String(p.default ?? '')}
                             onChange={(e) => setParams((s) => ({ ...s, [p.name]: e.target.value }))} />
                    </label>
                  ))}
                  <button className="btn primary" onClick={run} disabled={busy}>Apply</button>
                </div>
              )}
            </div>

            {headline && <KpiStrip headline={headline} currency={project?.currency_code ?? ''} spark={spark} />}

            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
                <div className="segmented">
                  {(['chart', 'table', 'sql'] as Tab[]).map((t) => (
                    <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}
                            disabled={t === 'chart' && !!result && !vizRenders(result, viz)}>
                      {t === 'chart' ? 'Chart' : t === 'table' ? 'Table' : 'SQL'}
                    </button>
                  ))}
                </div>
                {result && (
                  <span className="faint" style={{ fontSize: 12, alignSelf: 'center' }}>
                    {result.rowCount.toLocaleString()} rows · {result.ms} ms
                  </span>
                )}
              </div>

              {!result ? (
                <div className="empty">{busy ? 'Running…' : 'No result yet.'}</div>
              ) : tab === 'chart' ? (
                <VizPanel result={result} viz={viz} />
              ) : tab === 'table' ? (
                <DataTable result={result} maxHeight={520} signColumns={SIGN_COLUMNS} />
              ) : (
                <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6,
                       color: 'var(--text-2)', maxHeight: 520, overflow: 'auto' }}>
                  {query.sql_text}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
