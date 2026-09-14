import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { DataTable } from '../components/DataTable';
import type { QueryResult, StoredQuery } from '@shared/types';

const BLANK = {
  query_id: undefined as number | undefined,
  code: '',
  name: '',
  module: 'CROSS',
  category: '',
  description: '',
  sql_text: 'SELECT *\nFROM v_actual\nWHERE project_key = :project_key\nLIMIT 100',
  params_json: '[{"name":"project_key","type":"project","label":"Project"}]',
};

/**
 * The SQL behind every report lives in the database, editable here.
 * System queries are read-only (they are re-seeded from the app on each start);
 * "Duplicate" turns one into an editable copy.
 */
export function QueryLibrary() {
  const { projectKey } = useApp();
  const [queries, setQueries] = useState<StoredQuery[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState({ ...BLANK });
  const [result, setResult] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    const rows = await call(api.queries.list()) as StoredQuery[];
    setQueries(rows);
    return rows;
  };

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  const current = useMemo(() => queries.find((q) => q.query_id === selected) ?? null, [queries, selected]);
  const readOnly = !!current?.is_system;

  const open = (q: StoredQuery) => {
    setSelected(q.query_id);
    setDraft({
      query_id: q.query_id, code: q.code, name: q.name, module: q.module,
      category: q.category ?? '', description: q.description ?? '',
      sql_text: q.sql_text, params_json: q.params_json,
    });
    setResult(null);
    setNote(null);
  };

  const newQuery = () => { setSelected(null); setDraft({ ...BLANK }); setResult(null); setNote(null); };

  const duplicate = () => {
    setSelected(null);
    setDraft((d) => ({ ...d, query_id: undefined, code: `${d.code}_COPY`, name: `${d.name} (copy)` }));
    setNote('Editing a copy — save it to add it to the library.');
  };

  const runDraft = async () => {
    setBusy(true); setError(null);
    try {
      let params: Record<string, unknown> = {};
      try {
        for (const p of JSON.parse(draft.params_json) as { name: string; type: string; default?: unknown }[]) {
          params[p.name] = p.type === 'project' ? projectKey : p.default ?? null;
        }
      } catch { params = { project_key: projectKey }; }
      setResult(await call(api.queries.runSql(draft.sql_text, params)) as QueryResult);
    } catch (e) {
      setError((e as Error).message); setResult(null);
    } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      JSON.parse(draft.params_json); // fail fast on malformed parameter JSON
      const { query_id } = await call(api.queries.save(draft));
      const rows = await load();
      const saved = rows.find((q) => q.query_id === query_id);
      if (saved) open(saved);
      setNote('Saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!draft.query_id) return;
    setBusy(true); setError(null);
    try {
      await call(api.queries.remove(draft.query_id));
      await load();
      newQuery();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
      <div className="card" style={{ maxHeight: 'calc(100vh - 140px)', overflow: 'auto' }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Library</h3>
          <button className="btn sm" onClick={newQuery}>+ New</button>
        </div>
        {[...new Set(queries.map((q) => q.module))].map((m) => (
          <div key={m}>
            <div className="nav-group" style={{ padding: '0 0 4px' }}>{m}</div>
            {queries.filter((q) => q.module === m).map((q) => (
              <button
                key={q.query_id}
                className={`nav-item ${selected === q.query_id ? 'active' : ''}`}
                onClick={() => open(q)}
                title={q.description ?? ''}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.name}</span>
                {q.is_system ? <span className="badge mute" style={{ marginLeft: 'auto' }}>sys</span> : null}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div>
        {error && <div className="banner err">{error}</div>}
        {note && <div className="banner ok">{note}</div>}

        <div className="card">
          <div className="row">
            <label className="field"><span>Code</span>
              <input value={draft.code} disabled={readOnly} style={{ width: 180 }}
                     onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}><span>Name</span>
              <input value={draft.name} disabled={readOnly}
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="field"><span>Module</span>
              <select value={draft.module} disabled={readOnly}
                      onChange={(e) => setDraft({ ...draft, module: e.target.value })}>
                {['ACTUAL', 'BUDGET', 'FORECAST', 'CROSS', 'ADMIN'].map((m) => <option key={m}>{m}</option>)}
              </select>
            </label>
            <label className="field"><span>Category</span>
              <input value={draft.category} disabled={readOnly} style={{ width: 140 }}
                     onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
            </label>
          </div>

          <label className="field" style={{ marginTop: 12 }}><span>Description</span>
            <input value={draft.description} disabled={readOnly}
                   onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>

          <label className="field" style={{ marginTop: 12 }}>
            <span>SQL — read-only statements only; use <code className="mono">:name</code> for parameters</span>
            <textarea rows={16} value={draft.sql_text} disabled={readOnly}
                      onChange={(e) => setDraft({ ...draft, sql_text: e.target.value })} />
          </label>

          <label className="field" style={{ marginTop: 12 }}><span>Parameters (JSON)</span>
            <textarea rows={3} value={draft.params_json} disabled={readOnly}
                      onChange={(e) => setDraft({ ...draft, params_json: e.target.value })} />
          </label>

          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={runDraft} disabled={busy}>
              {busy ? <span className="spinner" /> : '▷'} Run
            </button>
            {!readOnly && <button className="btn" onClick={save} disabled={busy || !draft.code || !draft.name}>Save</button>}
            {readOnly && <button className="btn" onClick={duplicate}>Duplicate to edit</button>}
            {!readOnly && draft.query_id && <button className="btn danger" onClick={remove} disabled={busy}>Delete</button>}
            {readOnly && <span className="faint" style={{ alignSelf: 'center' }}>
              System query — shipped with the app and refreshed on start.
            </span>}
          </div>
        </div>

        {result && (
          <div className="card">
            <DataTable result={result} maxHeight={380} />
          </div>
        )}
      </div>
    </div>
  );
}
