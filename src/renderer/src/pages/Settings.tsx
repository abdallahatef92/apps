import { Fragment, useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { THEMES, applyTheme, getTheme, type ThemeId } from '../lib/theme';

/** Tokens shown as each theme tile's swatch strip, resolved inside that tile's own preview scope. */
const THEME_SWATCHES = ['--surface', '--accent', '--ink-good', '--ink-bad', '--series-2'];

/**
 * One tile per theme. Each tile sets data-theme-preview, which re-declares that
 * theme's tokens for its subtree, so the tile is drawn in its own theme.
 */
function AppearancePicker() {
  const [active, setActive] = useState<ThemeId>(() => getTheme());
  const pick = (id: ThemeId) => { applyTheme(id); setActive(id); };
  return (
    <div className="grid k4">
      {THEMES.map((t) => {
        const isActive = t.id === active;
        return (
          <button key={t.id} type="button" className="theme-tile" data-theme-preview={t.id}
                  aria-pressed={isActive} onClick={() => pick(t.id)}>
            <span className="theme-tile-head">
              <span className="theme-tile-label">{t.label}</span>
              <span className="badge mute plain">{t.mode}</span>
              {isActive && <span className="badge info">Active</span>}
            </span>
            <span className="theme-tile-desc">{t.description}</span>
            <span className="theme-swatches" aria-hidden="true">
              {THEME_SWATCHES.map((v) => (
                <span key={v} className="theme-swatch" style={{ background: `var(${v})` }} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Settings() {
  const { projects, refresh, touch, devTools, setDevTools } = useApp();
  const [info, setInfo] = useState<{ version: string; dbPath: string; userData: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    projectKey: number; mode: 'clear' | 'delete'; typed: string; footprint: { lines: number; files: number } | null;
  } | null>(null);
  const [form, setForm] = useState({ project_code: '', project_name: '', client_name: '', currency_code: 'USD', contract_value: '' });

  useEffect(() => {
    api.app.info().then((r) => { if (r.ok) setInfo(r.data); });
  }, []);

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

  const askRemove = (projectKey: number, mode: 'clear' | 'delete') => {
    setError(null); setNote(null);
    setPending({ projectKey, mode, typed: '', footprint: null });
    api.projects.footprint(projectKey).then((r) => {
      if (r.ok) setPending((cur) => (cur && cur.projectKey === projectKey ? { ...cur, footprint: r.data } : cur));
    });
  };

  const confirmRemove = () => guard(async () => {
    if (!pending) return;
    const code = projects.find((p) => p.project_key === pending.projectKey)?.project_code ?? '';
    const res = await call(pending.mode === 'delete'
      ? api.projects.remove(pending.projectKey)
      : api.projects.clearData(pending.projectKey));
    setPending(null);
    await refresh();
    touch();
    setNote(`${pending.mode === 'delete' ? `Project ${code} deleted` : `Data of ${code} removed`}: `
      + `${res.lines.toLocaleString()} lines, ${res.files} file${res.files === 1 ? '' : 's'}. Copy saved first at ${res.backupPath}`);
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
        <h3>Appearance</h3>
        <p className="hint">
          Layout theme for this computer. Charts keep the same meaning in every theme: blue is on
          track, orange is over budget.
        </p>
        <AppearancePicker />
      </div>

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
            <thead><tr><th>Code</th><th>Name</th><th>Currency</th><th /></tr></thead>
            <tbody>
              {projects.length === 0 && <tr><td colSpan={4}><div className="empty">No projects yet.</div></td></tr>}
              {projects.map((p) => (
                <Fragment key={p.project_key}>
                  <tr>
                    <td className="mono">{p.project_code}</td>
                    <td>{p.project_name}</td>
                    <td>{p.currency_code ?? '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn sm" disabled={busy} onClick={() => askRemove(p.project_key, 'clear')}>Remove data…</button>{' '}
                      <button className="btn sm danger" disabled={busy} onClick={() => askRemove(p.project_key, 'delete')}>Delete…</button>
                    </td>
                  </tr>
                  {pending?.projectKey === p.project_key && (
                    <tr className="confirm-row">
                      <td colSpan={4}>
                        <div className="confirm-box">
                          <strong>
                            {pending.mode === 'delete' ? `Delete project ${p.project_code}?` : `Remove all data of ${p.project_code}?`}
                          </strong>
                          <p className="hint" style={{ margin: '4px 0 8px' }}>
                            {pending.footprint
                              ? `${pending.footprint.lines.toLocaleString()} lines from ${pending.footprint.files} uploaded file${pending.footprint.files === 1 ? '' : 's'} will be removed`
                              : 'Counting what will be removed…'}
                            {pending.mode === 'delete'
                              ? ', together with the project, its cut-off, work-package and MNL coding.'
                              : '. The project, its cut-off, work-package and MNL coding stay, ready for new uploads.'}
                            {' '}A file that also carries another project keeps that project's lines. A copy of the database
                            is saved first, so this can be undone by opening that copy.
                          </p>
                          <div className="row">
                            <label className="field"><span>Type {p.project_code} to confirm</span>
                              <input value={pending.typed} autoFocus style={{ width: 180 }}
                                     onChange={(e) => setPending({ ...pending, typed: e.target.value })} />
                            </label>
                            <button className="btn danger" disabled={busy || pending.typed.trim() !== p.project_code}
                                    onClick={confirmRemove}>
                              {pending.mode === 'delete' ? 'Delete project' : 'Remove data'}
                            </button>
                            <button className="btn" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Developer tools</h3>
        <p className="hint">
          Analysis, Pivot builder, Query library, Schema diagram and Data lineage — the tools used to build and
          check the app. The monthly routine does not need them, so they are out of the menu unless switched on.
        </p>
        <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={devTools} onChange={(e) => setDevTools(e.target.checked)} />
          <span>Show developer tools in the menu</span>
        </label>
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
