import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { DataTable } from '../components/DataTable';
import { BarChart } from '../charts/BarChart';
import type { PivotSource, QueryResult } from '@shared/types';

type Tab = 'chart' | 'table' | 'sql';

/**
 * Ad-hoc exploration that still produces a real query: the picks below are
 * compiled to SQL in the main process from a whitelist of views, dimensions and
 * measures, shown in full, and savable into the library as a normal analysis.
 */
export function Pivot({ onError }: { onError: (m: string | null) => void }) {
  const { projectKey, project } = useApp();
  const [sources, setSources] = useState<PivotSource[]>([]);
  const [sourceKey, setSourceKey] = useState('ACTUAL');
  const [dims, setDims] = useState<string[]>(['cost_type']);
  const [measures, setMeasures] = useState<string[]>(['amount']);
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');
  const [limit, setLimit] = useState('200');

  const [sql, setSql] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [tab, setTab] = useState<Tab>('chart');
  const [busy, setBusy] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    call(api.pivot.meta()).then(setSources).catch((e) => onError((e as Error).message));
  }, [onError]);

  const source = useMemo(() => sources.find((s) => s.key === sourceKey), [sources, sourceKey]);

  // Keep the picks valid when the source changes.
  useEffect(() => {
    if (!source) return;
    setDims((d) => {
      const kept = d.filter((k) => source.dimensions.some((x) => x.key === k));
      return kept.length ? kept : [source.dimensions[0].key];
    });
    setMeasures((m) => {
      const kept = m.filter((k) => source.measures.some((x) => x.key === k));
      return kept.length ? kept : [source.measures[0].key];
    });
  }, [source]);

  const toggle = (list: string[], key: string, set: (v: string[]) => void, min = 0) => {
    const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
    if (next.length >= min) set(next);
  };

  const run = async () => {
    if (!source || !projectKey) return;
    setBusy(true); onError(null); setNote(null);
    try {
      const built = await call(api.pivot.build({
        source: sourceKey, dimensions: dims, measures, limit: Number(limit) || 200,
      }));
      setSql(built);
      const res = await call(api.queries.runSql(built, {
        project_key: projectKey,
        period_from: periodFrom || null,
        period_to: periodTo || null,
        row_limit: Number(limit) || 200,
      })) as QueryResult;
      setResult(res);
    } catch (e) { onError((e as Error).message); setResult(null); }
    finally { setBusy(false); }
  };

  // `sources.length` matters: the metadata arrives asynchronously, and without it
  // the first render finds no source and never comes back to run.
  useEffect(() => { if (source && projectKey) run(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources.length, sourceKey, dims.join(), measures.join(), projectKey]);

  const save = async () => {
    if (!sql || !saveName.trim()) return;
    setBusy(true); onError(null);
    try {
      const code = saveName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 40);
      await call(api.queries.save({
        code, name: saveName.trim(), module: 'CROSS', category: 'Saved pivot',
        description: `Built in the pivot builder from ${source?.label}.`,
        sql_text: sql,
        params_json: JSON.stringify([
          { name: 'project_key', type: 'project', label: 'Project', required: true },
          { name: 'period_from', type: 'period', label: 'Period from' },
          { name: 'period_to', type: 'period', label: 'Period to' },
          { name: 'row_limit', type: 'int', label: 'Rows', default: Number(limit) || 200 },
        ]),
        viz_json: JSON.stringify({ kind: 'bar', label: dims[0], value: measures[0] }),
      }));
      setNote(`Saved as "${saveName.trim()}" — it is in the list on the left now.`);
      setSaveName('');
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };

  const exportXlsx = async () => {
    if (!result) return;
    try {
      await call(api.exportResult(result, {
        title: `Pivot — ${source?.label}`,
        subtitle: `${dims.join(', ')} by ${measures.join(', ')}`,
        context: { Project: project?.project_code, From: periodFrom, To: periodTo, SQL: sql },
      }));
    } catch (e) { onError((e as Error).message); }
  };

  if (!source) return <div className="card"><div className="empty">Loading…</div></div>;

  return (
    <>
      {note && <div className="banner ok">{note}</div>}

      <div className="card">
        <h3>Pivot builder</h3>
        <p className="hint">
          Pick a source, what to group by and what to measure. The SQL is generated against the
          reporting views and shown in full — save it and it becomes a normal analysis.
        </p>

        <div className="row" style={{ marginBottom: 14 }}>
          <label className="field" style={{ minWidth: 230 }}>
            <span>Source</span>
            <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
              {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="field"><span>Period from</span>
            <input placeholder="YYYY-MM" style={{ width: 110 }} value={periodFrom}
                   onChange={(e) => setPeriodFrom(e.target.value)} />
          </label>
          <label className="field"><span>Period to</span>
            <input placeholder="YYYY-MM" style={{ width: 110 }} value={periodTo}
                   onChange={(e) => setPeriodTo(e.target.value)} />
          </label>
          <label className="field"><span>Rows</span>
            <input style={{ width: 80 }} value={limit} onChange={(e) => setLimit(e.target.value)} />
          </label>
          <button className="btn primary" onClick={run} disabled={busy}>
            {busy ? <span className="spinner" /> : '▷'} Run
          </button>
        </div>

        <div className="grid k2">
          <div>
            <div className="nav-group" style={{ padding: 0, marginTop: 0 }}>Group by</div>
            <div className="row" style={{ gap: 6 }}>
              {source.dimensions.map((d) => (
                <button key={d.key} className={`badge plain ${dims.includes(d.key) ? 'info' : 'mute'}`}
                        style={{ cursor: 'pointer', border: '1px solid', padding: '4px 10px' }}
                        onClick={() => toggle(dims, d.key, setDims, 1)}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="nav-group" style={{ padding: 0, marginTop: 0 }}>Measure</div>
            <div className="row" style={{ gap: 6 }}>
              {source.measures.map((m) => (
                <button key={m.key} className={`badge plain ${measures.includes(m.key) ? 'info' : 'mute'}`}
                        style={{ cursor: 'pointer', border: '1px solid', padding: '4px 10px' }}
                        onClick={() => toggle(measures, m.key, setMeasures, 1)}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="segmented">
            {(['chart', 'table', 'sql'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'chart' ? 'Chart' : t === 'table' ? 'Table' : 'SQL'}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input placeholder="Save as…" value={saveName} style={{ width: 180 }}
                   onChange={(e) => setSaveName(e.target.value)} />
            <button className="btn" onClick={save} disabled={busy || !saveName.trim() || !sql}>
              Save to library
            </button>
            <button className="btn" onClick={exportXlsx} disabled={!result?.rowCount}>⤓ Excel</button>
          </div>
        </div>

        {!result ? <div className="empty">{busy ? 'Running…' : 'Pick a grouping to see results.'}</div>
          : tab === 'chart' ? <BarChart result={result} labelColumn={dims[0]} valueColumn={measures[0]} />
          : tab === 'table' ? <DataTable result={result} maxHeight={480} />
          : <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6,
                   color: 'var(--text-2)' }}>{sql}</pre>}
      </div>
    </>
  );
}
