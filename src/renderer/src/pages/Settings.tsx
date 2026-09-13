import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';

export function Settings() {
  const { projects, refresh } = useApp();
  const [info, setInfo] = useState<{ version: string; dbPath: string; userData: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ project_code: '', project_name: '', client_name: '', currency_code: 'USD', contract_value: '' });
  const [revenuePattern, setRevenuePattern] = useState('^4');

  useEffect(() => {
    api.app.info().then((r) => { if (r.ok) setInfo(r.data); });
    api.settings.list().then((r) => {
      if (r.ok) setRevenuePattern(r.data.find((x) => x.key === 'revenue_account_pattern')?.value ?? '^4');
    });
  }, []);

  const saveClassification = () => guard(async () => {
    await call(api.settings.set('revenue_account_pattern', revenuePattern));
    const res = await call(api.settings.reclassify());
    setNote(`Rule saved and applied to ${res.costElements} cost elements already loaded.`);
  });

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const addProject = () => guard(async () => {
    if (!form.project_code.trim() || !form.project_name.trim()) throw new Error('Code and name are required.');
    await call(api.projects.create({
      ...form,
      contract_value: form.contract_value ? Number(form.contract_value) : null,
    }));
    setForm({ project_code: '', project_name: '', client_name: '', currency_code: 'USD', contract_value: '' });
    await refresh();
    setNote('Project created.');
  });

  const backup = () => guard(async () => {
    const path = await call(api.db.backup());
    setNote(path ? `Backed up to ${path}` : 'Backup cancelled.');
  });

  const openDb = () => guard(async () => {
    const res = await call(api.db.open());
    if (res.changed) { await refresh(); setNote(`Now using ${res.dbPath}. Restart is not required.`); }
  });

  return (
    <>
      {error && <div className="banner err">{error}</div>}
      {note && <div className="banner ok">{note}</div>}

      <div className="card">
        <h3>Database</h3>
        <p className="hint">
          Everything lives in one SQLite file. Copy it to move the whole warehouse to another machine.
        </p>
        <div className="mono faint" style={{ marginBottom: 12, wordBreak: 'break-all' }}>{info?.dbPath}</div>
        <div className="row">
          <button className="btn" onClick={backup} disabled={busy}>Back up now</button>
          <button className="btn" onClick={openDb} disabled={busy}>Open another database…</button>
        </div>
      </div>

      <div className="card">
        <h3>Cost classification</h3>
        <p className="hint">
          A CJI3 export carries income as well as cost, posted as negative amounts. Cost elements
          whose account matches this pattern are treated as revenue and kept out of actual cost —
          otherwise billing would silently cancel out spend. The default <code className="mono">^4</code>
          {' '}suits the usual SAP operating chart, where 4xxxxxxx is income and 3xxxxxxx is expense.
        </p>
        <div className="row">
          <label className="field">
            <span>Revenue account pattern (regular expression)</span>
            <input value={revenuePattern} style={{ width: 200 }} className="mono"
                   onChange={(e) => setRevenuePattern(e.target.value)} />
          </label>
          <button className="btn" onClick={saveClassification} disabled={busy}>
            Save and reclassify
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Projects</h3>
        <p className="hint">
          Projects are also created automatically from a project code column during upload;
          add one here when the file has no project column.
        </p>

        <div className="row" style={{ marginBottom: 14 }}>
          <label className="field"><span>Code</span>
            <input value={form.project_code} style={{ width: 140 }}
                   onChange={(e) => setForm({ ...form, project_code: e.target.value })} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}><span>Name</span>
            <input value={form.project_name} onChange={(e) => setForm({ ...form, project_name: e.target.value })} />
          </label>
          <label className="field"><span>Client</span>
            <input value={form.client_name} onChange={(e) => setForm({ ...form, client_name: e.target.value })} />
          </label>
          <label className="field"><span>Currency</span>
            <select value={form.currency_code} onChange={(e) => setForm({ ...form, currency_code: e.target.value })}>
              {['USD', 'EUR', 'GBP', 'SAR', 'AED', 'EGP', 'QAR', 'KWD'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="field"><span>Contract value</span>
            <input value={form.contract_value} style={{ width: 140 }}
                   onChange={(e) => setForm({ ...form, contract_value: e.target.value })} />
          </label>
          <button className="btn primary" onClick={addProject} disabled={busy}>Add project</button>
        </div>

        <div className="table-wrap">
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Currency</th></tr></thead>
            <tbody>
              {projects.length === 0 && <tr><td colSpan={3}><div className="empty">No projects yet.</div></td></tr>}
              {projects.map((p) => (
                <tr key={p.project_key}>
                  <td className="mono">{p.project_code}</td>
                  <td>{p.project_name}</td>
                  <td>{p.currency_code ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>About</h3>
        <p className="hint" style={{ marginBottom: 0 }}>
          Cost Intelligence v{info?.version ?? '—'} — local-first cost control warehouse.
          Aggregation is performed by SQL stored in the database, not in the interface, so every
          number on screen can be traced to a query and a data date.
        </p>
      </div>
    </>
  );
}
