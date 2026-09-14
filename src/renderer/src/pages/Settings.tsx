import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import {
  COST_TYPE_VALUES,
  type CostType, type CostTypeCombination, type CostTypePreviewRow, type CostTypeRule,
} from '@shared/types';

const money = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export function Settings() {
  const { projects, refresh } = useApp();
  const [info, setInfo] = useState<{ version: string; dbPath: string; userData: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ project_code: '', project_name: '', client_name: '', currency_code: 'USD', contract_value: '' });
  const [revenuePattern, setRevenuePattern] = useState('^4');
  const [rules, setRules] = useState<CostTypeRule[]>([]);
  const [preview, setPreview] = useState<CostTypePreviewRow[]>([]);

  const [combos, setCombos] = useState<CostTypeCombination[]>([]);
  // Only what the user has actually changed, keyed "code doctype".
  const [pending, setPending] = useState<Record<string, CostType | ''>>({});

  const comboKey = (c: { cost_element_code: string; document_type: string }) =>
    `${c.cost_element_code} ${c.document_type}`;

  const loadCostTypes = async () => {
    const [r, p, c] = await Promise.all([
      api.costTypes.list(), api.costTypes.preview(), api.costTypes.combinations(),
    ]);
    if (r.ok) setRules(r.data);
    if (p.ok) setPreview(p.data);
    if (c.ok) setCombos(c.data);
    setPending({});
  };

  const saveAllocations = () => guard(async () => {
    const items = Object.entries(pending).map(([k, v]) => {
      // An account code carries no space; a document type conceivably could, so
      // only the first space separates the two halves of the key.
      const [cost_element_code, ...rest] = k.split(' ');
      return { cost_element_code, document_type: rest.join(' '), cost_type: v === '' ? null : v };
    });
    if (items.length === 0) throw new Error('Nothing to save — no allocation was changed.');
    const res = await call(api.costTypes.assign(items));
    await loadCostTypes();
    setNote(`${res.assigned} allocated, ${res.cleared} returned to the patterns. `
      + 'Every report reflects this now.');
  });

  useEffect(() => {
    api.app.info().then((r) => { if (r.ok) setInfo(r.data); });
    api.settings.list().then((r) => {
      if (r.ok) setRevenuePattern(r.data.find((x) => x.key === 'revenue_account_pattern')?.value ?? '^4');
    });
    loadCostTypes();
  }, []);

  const editRule = (i: number, patch: Partial<CostTypeRule>) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const moveRule = (i: number, by: number) => setRules((rs) => {
    const j = i + by;
    if (j < 0 || j >= rs.length) return rs;
    const next = [...rs];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const addRule = () => setRules((rs) => [...rs, {
    rule_id: null, priority: (rs.length + 1) * 10,
    cost_element_glob: '', document_type_glob: '', cost_type: 'OTHER', note: null, is_active: 1,
  }]);

  const saveRules = () => guard(async () => {
    // Order on screen is the order of evaluation; renumber so it survives a reload.
    const ordered = rules.map((r, i) => ({ ...r, priority: (i + 1) * 10 }));
    const res = await call(api.costTypes.save(ordered));
    await loadCostTypes();
    setNote(`${res.rules} rules saved. Every report reflects them now — no re-import needed.`);
  });

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
        <h3>Allocate cost types</h3>
        <p className="hint">
          Every combination of cost element and document type that actually occurs in the
          cost already loaded — {combos.length} of them, biggest first. Set one and it is
          answered outright; leave it on <em>inherit</em> and the patterns below decide.
          An allocation is written as an exact rule, so it always wins over a pattern, and
          it takes effect immediately — no re-import.
        </p>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cost element</th>
                <th>Description</th>
                <th>Doc type</th>
                <th style={{ textAlign: 'right' }}>Postings</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Now</th>
                <th style={{ width: 150 }}>Allocate</th>
              </tr>
            </thead>
            <tbody>
              {combos.length === 0 && (
                <tr><td colSpan={7}><div className="empty">No actual cost loaded yet.</div></td></tr>
              )}
              {combos.map((c) => {
                const key = comboKey(c);
                const current = key in pending
                  ? pending[key]
                  : (c.assigned_cost_type ?? '');
                const changed = key in pending;
                return (
                  <tr key={key}>
                    <td className="mono">{c.cost_element_code}</td>
                    <td>{c.cost_element_name ?? '—'}</td>
                    <td className="mono">{c.document_type || <span className="faint">(none)</span>}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{c.postings.toLocaleString()}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{money(c.amount)}</td>
                    <td className={c.assigned_cost_type ? undefined : 'faint'}>
                      {c.resolved_cost_type ?? 'UNMAPPED'}
                      {!c.assigned_cost_type && <span className="faint"> (pattern)</span>}
                    </td>
                    <td>
                      <select value={current} style={changed ? { borderColor: 'var(--accent)' } : undefined}
                              onChange={(e) => setPending((p) => ({
                                ...p, [key]: e.target.value as CostType | '',
                              }))}>
                        <option value="">inherit</option>
                        {COST_TYPE_VALUES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={saveAllocations}
                  disabled={busy || Object.keys(pending).length === 0}>
            Save {Object.keys(pending).length || ''} allocation{Object.keys(pending).length === 1 ? '' : 's'}
          </button>
          {Object.keys(pending).length > 0 && (
            <button className="btn" onClick={() => setPending({})} disabled={busy}>Discard changes</button>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Cost type mapping</h3>
        <p className="hint">
          Which postings count as labour, material, subcontract and so on. Rules are tried
          top to bottom and the first match wins, so put the specific ones above the general
          ones. Patterns are SQL <code className="mono">GLOB</code>, not regular expressions —
          {' '}<code className="mono">301*</code> means "account starts with 301",
          {' '}<code className="mono">*</code> on its own means any. Leave a column blank for
          "any". Matching on document type as well as account lets the same account be split
          by how it was posted, which an account range alone cannot express.
        </p>
        <p className="hint">
          A cost type stated by the source file still wins over these rules. Rules are read
          when a report runs, so a change here corrects history too — there is nothing to
          re-import.
        </p>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }}>#</th>
                <th>Cost element</th>
                <th>Document type</th>
                <th>Cost type</th>
                <th>Note</th>
                <th style={{ width: 56 }}>Active</th>
                <th style={{ width: 90 }}>Order</th>
                <th style={{ width: 34 }}></th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && (
                <tr><td colSpan={8}><div className="empty">No rules — every cost type will read as UNMAPPED.</div></td></tr>
              )}
              {rules.map((r, i) => (
                <tr key={i}>
                  <td className="faint mono">{i + 1}</td>
                  <td>
                    <input className="mono" style={{ width: 110 }} placeholder="any"
                           value={r.cost_element_glob ?? ''}
                           onChange={(e) => editRule(i, { cost_element_glob: e.target.value })} />
                  </td>
                  <td>
                    <input className="mono" style={{ width: 90 }} placeholder="any"
                           value={r.document_type_glob ?? ''}
                           onChange={(e) => editRule(i, { document_type_glob: e.target.value })} />
                  </td>
                  <td>
                    <select value={r.cost_type}
                            onChange={(e) => editRule(i, { cost_type: e.target.value as CostTypeRule['cost_type'] })}>
                      {COST_TYPE_VALUES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td>
                    <input style={{ width: '100%', minWidth: 160 }} placeholder="why this rule exists"
                           value={r.note ?? ''}
                           onChange={(e) => editRule(i, { note: e.target.value })} />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={r.is_active !== 0}
                           onChange={(e) => editRule(i, { is_active: e.target.checked ? 1 : 0 })} />
                  </td>
                  <td>
                    <button className="btn" style={{ padding: '2px 7px' }} disabled={i === 0}
                            onClick={() => moveRule(i, -1)} title="Move up">↑</button>
                    {' '}
                    <button className="btn" style={{ padding: '2px 7px' }} disabled={i === rules.length - 1}
                            onClick={() => moveRule(i, 1)} title="Move down">↓</button>
                  </td>
                  <td>
                    <button className="btn" style={{ padding: '2px 7px' }} title="Delete rule"
                            onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={addRule} disabled={busy}>Add rule</button>
          <button className="btn primary" onClick={saveRules} disabled={busy}>Save mapping</button>
        </div>

        <h4 style={{ marginTop: 18, marginBottom: 6 }}>What the rules classify today</h4>
        <p className="hint">
          Actual cost already loaded, split by the rules above. A large
          {' '}<code className="mono">UNMAPPED</code> share means the rules do not fit this
          chart of accounts — the breakdown charts will collapse into one bar rather than fail.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Cost type</th><th style={{ textAlign: 'right' }}>Postings</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {preview.length === 0 && <tr><td colSpan={3}><div className="empty">No actual cost loaded yet.</div></td></tr>}
              {preview.map((p) => (
                <tr key={p.cost_type}>
                  <td className={p.cost_type === 'UNMAPPED' ? 'mono' : undefined}>{p.cost_type}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{p.postings.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
