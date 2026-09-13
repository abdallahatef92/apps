import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { DataTable } from '../components/DataTable';
import type { QueryResult, StoredQuery } from '@shared/types';

interface ParamDef { name: string; type: string; label: string; required?: boolean; default?: string | number }

const SIGN_COLUMNS = ['variance_amount', 'vac_amount', 'overrun_amount', 'delta', 'cv'];

export function Analysis() {
  const { projectKey, dataVersion } = useApp();
  const [queries, setQueries] = useState<StoredQuery[]>([]);
  const [code, setCode] = useState<string>('BVA_BY_WBS');
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  useEffect(() => {
    call(api.queries.list())
      .then((q) => setQueries((q as StoredQuery[]).filter((x) => x.module !== 'ADMIN')))
      .catch((e) => setError((e as Error).message));
  }, []);

  const query = useMemo(() => queries.find((q) => q.code === code), [queries, code]);
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
      setResult(await call(api.queries.run(query.code, effective)) as QueryResult);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  // Re-run automatically when the project or the underlying data changes.
  useEffect(() => { if (query) run(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, projectKey, dataVersion, queries.length]);

  const exportXlsx = async () => {
    if (!result || !query) return;
    setBusy(true); setError(null);
    try {
      const path = await call(api.exportResult(result, {
        title: query.name,
        subtitle: query.description ?? '',
        context: { Project: projectKey, ...effective },
      }));
      setSavedTo(path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const byModule = useMemo(() => {
    const groups = new Map<string, StoredQuery[]>();
    for (const q of queries) {
      const list = groups.get(q.module) ?? [];
      list.push(q);
      groups.set(q.module, list);
    }
    return [...groups.entries()];
  }, [queries]);

  return (
    <>
      {error && <div className="banner err">{error}</div>}
      {savedTo && (
        <div className="banner ok">
          Exported to <span className="mono">{savedTo}</span>
          <button className="btn sm ghost" style={{ marginLeft: 10 }} onClick={() => api.showItem(savedTo)}>
            Show in folder
          </button>
        </div>
      )}

      <div className="card">
        <div className="row">
          <label className="field" style={{ minWidth: 320 }}>
            <span>Analysis</span>
            <select value={code} onChange={(e) => { setCode(e.target.value); setParams({}); }}>
              {byModule.map(([m, list]) => (
                <optgroup key={m} label={m}>
                  {list.map((q) => <option key={q.code} value={q.code}>{q.name}</option>)}
                </optgroup>
              ))}
            </select>
          </label>

          {paramDefs.filter((p) => p.type !== 'project').map((p) => (
            <label className="field" key={p.name}>
              <span>{p.label}</span>
              <input
                style={{ width: p.type === 'int' ? 90 : 130 }}
                placeholder={p.type === 'period' ? 'YYYY-MM' : ''}
                value={params[p.name] ?? String(p.default ?? '')}
                onChange={(e) => setParams((s) => ({ ...s, [p.name]: e.target.value }))}
              />
            </label>
          ))}

          <button className="btn primary" onClick={run} disabled={busy}>
            {busy ? <span className="spinner" /> : '▷'} Run
          </button>
          <button className="btn" onClick={exportXlsx} disabled={busy || !result || result.rowCount === 0}>
            ⤓ Export to Excel
          </button>
        </div>

        {query?.description && <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>{query.description}</p>}
      </div>

      <div className="card">
        {result
          ? <DataTable result={result} maxHeight={560} signColumns={SIGN_COLUMNS} />
          : <div className="empty">{busy ? 'Running…' : 'Run an analysis to see results.'}</div>}
      </div>
    </>
  );
}
