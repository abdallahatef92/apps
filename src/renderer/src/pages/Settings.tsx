import { Fragment, useMemo, useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { Heatmap } from '../charts/Heatmap';
import {
  COST_TYPE_VALUES,
  type CostType, type CostTypeCombination, type QueryResult,
} from '@shared/types';

const money = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * One icon and colour per cost type, used only for this picker's buttons and
 * badges — deliberately not the chart series palette (styles.css --series-*),
 * which is reserved for encoding data in a chart and must never double as a
 * UI control colour.
 */
const COST_TYPE_META: Record<CostType, { icon: string; color: string; label: string }> = {
  LABOR:       { icon: '👷', color: '#e08fd0', label: 'Labor' },
  MATERIAL:    { icon: '📦', color: '#5ac8fa', label: 'Material' },
  SUBCONTRACT: { icon: '🔨', color: '#f5c15a', label: 'Subcontract' },
  EQUIPMENT:   { icon: '🔧', color: '#ff9f5a', label: 'Equipment' },
  INDIRECT:    { icon: '💼', color: '#7fd9c4', label: 'Indirect' },
  OTHER:       { icon: '❓', color: '#9aa5b1', label: 'Other' },
};

/**
 * Assign a cost type with one click instead of a dropdown: a row of icon
 * buttons, filled in that type's colour when selected. `value` of '' or
 * undefined means "not set" — nothing is filled, and no clear button shows.
 */
function CostTypePicker({ value, onChange, clearLabel = 'inherit' }: {
  value: CostType | '';
  onChange: (v: CostType | '') => void;
  clearLabel?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {COST_TYPE_VALUES.map((t) => {
        const meta = COST_TYPE_META[t];
        const selected = value === t;
        return (
          <button key={t} type="button" title={meta.label}
                  onClick={() => onChange(selected ? '' : t)}
                  style={{
                    fontSize: 13, lineHeight: 1, padding: '4px 7px', borderRadius: 6,
                    cursor: 'pointer', fontFamily: 'inherit',
                    background: selected ? meta.color : 'var(--surface-3)',
                    border: `1px solid ${selected ? meta.color : 'var(--border)'}`,
                    filter: selected ? 'none' : 'grayscale(0.4) opacity(0.75)',
                  }}>
            {meta.icon}
          </button>
        );
      })}
      {value !== '' && (
        <button type="button" title={`Clear — ${clearLabel}`} onClick={() => onChange('')}
                style={{ fontSize: 10, padding: '4px 6px', borderRadius: 6, cursor: 'pointer',
                         fontFamily: 'inherit', background: 'transparent', color: 'var(--text-3)',
                         border: '1px solid var(--border)' }}>
          ✕
        </button>
      )}
    </div>
  );
}

/** Small icon + label badge for showing a resolved cost type, not picking one. */
function CostTypeBadge({ type }: { type: string }) {
  const meta = COST_TYPE_META[type as CostType];
  if (!meta) {
    return <span className="faint mono">{type}</span>;
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
      color: meta.color, background: `${meta.color}22`, border: `1px solid ${meta.color}55`,
      borderRadius: 5, padding: '2px 8px', whiteSpace: 'nowrap',
    }}>
      <span>{meta.icon}</span>{meta.label}
    </span>
  );
}

interface CostTypeGroup {
  type: CostType | 'UNMAPPED';
  rows: CostTypeCombination[];
  postings: number;
  amount: number;
}

/** GL description if the file gave one, falling back to the code alone. */
const glLabel = (c: { cost_element_code: string; cost_element_name?: string | null }) =>
  c.cost_element_name ? `${c.cost_element_name} (${c.cost_element_code})` : c.cost_element_code;

/**
 * Group combinations by their current cost type — UNMAPPED first, since that
 * is the group needing attention — with the GL + document-type combinations
 * inside each sorted by GL description, not GL code. Purely a view of the
 * server's own truth: every allocation here is saved the moment it is made,
 * so there is no separate "pending" state to also account for.
 */
function groupByCostType(combos: CostTypeCombination[]): CostTypeGroup[] {
  const map = new Map<string, CostTypeGroup>();
  for (const c of combos) {
    const key = c.resolved_cost_type ?? 'UNMAPPED';
    const g = map.get(key) ?? { type: key as CostType | 'UNMAPPED', rows: [], postings: 0, amount: 0 };
    g.rows.push(c);
    g.postings += c.postings;
    g.amount += c.amount;
    map.set(key, g);
  }
  for (const g of map.values()) {
    g.rows.sort((a, b) =>
      glLabel(a).localeCompare(glLabel(b)) || a.document_type.localeCompare(b.document_type));
  }
  const order = ['UNMAPPED', ...COST_TYPE_VALUES];
  return [...map.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

type AllocateFn = (items: { cost_element_code: string; document_type: string; cost_type: CostType | null }[]) => void;

/**
 * The allocation grid as a pivot: one collapsible row per cost type, its GL +
 * document-type combinations nested beneath, sorted by GL description so the
 * list reads by what the account means rather than its number. Every picker
 * here — a single row's or a whole group's — saves the instant it is clicked;
 * the row reappears under its new group as soon as the save round-trips.
 */
function GroupedAllocationTable({ combos, savingKeys, allocate, comboKey }: {
  combos: CostTypeCombination[];
  savingKeys: Set<string>;
  allocate: AllocateFn;
  comboKey: (c: { cost_element_code: string; document_type: string }) => string;
}) {
  const groups = useMemo(() => groupByCostType(combos), [combos]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [allCollapsed, setAllCollapsed] = useState(true);

  const isOpen = (type: string) => collapsed[type] !== undefined ? !collapsed[type] : !allCollapsed;
  const toggle = (type: string) => setCollapsed((c) => ({ ...c, [type]: isOpen(type) }));
  const expandAll = () => { setAllCollapsed(false); setCollapsed({}); };
  const collapseAll = () => { setAllCollapsed(true); setCollapsed({}); };

  return (
    <div className="table-wrap">
      <div className="row" style={{ marginBottom: 8, gap: 8 }}>
        <button className="btn sm" onClick={expandAll}>Expand all</button>
        <button className="btn sm" onClick={collapseAll}>Collapse all</button>
        <span className="faint" style={{ fontSize: 11, alignSelf: 'center' }}>
          {combos.length} combination{combos.length === 1 ? '' : 's'} across {groups.length} cost type{groups.length === 1 ? '' : 's'}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 24 }}></th>
            <th>Cost type / GL</th>
            <th>Doc type</th>
            <th style={{ textAlign: 'right' }}>Postings</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
            <th style={{ width: 150 }}>Now</th>
            <th style={{ width: 240 }}>Allocate</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr><td colSpan={7}><div className="empty">No actual cost loaded yet.</div></td></tr>
          )}
          {groups.map((g) => {
            const open = isOpen(g.type);
            const groupSaving = g.rows.some((r) => savingKeys.has(comboKey(r)));
            return (
              <Fragment key={g.type}>
                <tr style={{ background: 'var(--surface-2)', cursor: 'pointer' }}
                    onClick={() => toggle(g.type)}>
                  <td className="faint" style={{ textAlign: 'center' }}>{open ? '▾' : '▸'}</td>
                  <td colSpan={2}>
                    {g.type === 'UNMAPPED'
                      ? <span className="faint mono" style={{ fontWeight: 700 }}>UNMAPPED</span>
                      : <CostTypeBadge type={g.type} />}
                    <span className="faint" style={{ fontSize: 11, marginLeft: 8 }}>
                      {g.rows.length} GL/doc-type combination{g.rows.length === 1 ? '' : 's'}
                    </span>
                    {groupSaving && <span className="faint" style={{ fontSize: 10, marginLeft: 8 }}>saving…</span>}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{g.postings.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(g.amount)}</td>
                  <td></td>
                  <td onClick={(e) => e.stopPropagation()}
                      style={groupSaving ? { opacity: .5, pointerEvents: 'none' } : undefined}>
                    <CostTypePicker value={g.type === 'UNMAPPED' ? '' : g.type} clearLabel="per-row"
                      onChange={(v) => allocate(g.rows.map((r) => ({
                        cost_element_code: r.cost_element_code, document_type: r.document_type,
                        cost_type: v || null,
                      })))} />
                  </td>
                </tr>
                {open && g.rows.map((c) => {
                  const key = comboKey(c);
                  const saving = savingKeys.has(key);
                  return (
                    <tr key={key}>
                      <td></td>
                      <td className="mono" style={{ paddingLeft: 20 }} title={c.cost_element_code}>
                        {glLabel(c)}
                      </td>
                      <td className="mono faint">{c.document_type || '(none)'}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{c.postings.toLocaleString()}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{money(c.amount)}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {c.resolved_cost_type
                            ? <CostTypeBadge type={c.resolved_cost_type} />
                            : <span className="faint mono">UNMAPPED</span>}
                          {!c.assigned_cost_type && c.resolved_cost_type && (
                            <span className="faint" style={{ fontSize: 10 }}>(pattern)</span>
                          )}
                          {saving && <span className="faint" style={{ fontSize: 10 }}>saving…</span>}
                        </div>
                      </td>
                      <td style={saving ? { opacity: .5, pointerEvents: 'none' } : undefined}>
                        <CostTypePicker value={c.assigned_cost_type ?? ''}
                          onChange={(v) => allocate([{
                            cost_element_code: c.cost_element_code, document_type: c.document_type,
                            cost_type: v || null,
                          }])} />
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A small GL x document-type matrix — not a full report, just enough to show
 * which document types actually post against which GLs. Capped to the
 * biggest GLs by spend so it stays a quick illustration, not another table.
 */
function GlDocTypeMatrix({ combos, maxGl = 12 }: { combos: CostTypeCombination[]; maxGl?: number }) {
  const result: QueryResult = useMemo(() => {
    const totals = new Map<string, { label: string; amount: number }>();
    for (const c of combos) {
      const t = totals.get(c.cost_element_code) ?? { label: glLabel(c), amount: 0 };
      t.amount += c.amount;
      totals.set(c.cost_element_code, t);
    }
    const top = [...totals.entries()]
      .sort((a, b) => Math.abs(b[1].amount) - Math.abs(a[1].amount))
      .slice(0, maxGl);
    const topCodes = new Map(top.map(([code, t]) => [code, t.label]));

    // Same GL + document type can appear as more than one combo (split by
    // cost type), so amounts are summed rather than the last one winning.
    const cells = new Map<string, number>();
    for (const c of combos) {
      const label = topCodes.get(c.cost_element_code);
      if (!label) continue;
      const key = `${label}|${c.document_type || '(none)'}`;
      cells.set(key, (cells.get(key) ?? 0) + c.amount);
    }
    const rows = [...top].flatMap(([, t]) =>
      [...cells.entries()]
        .filter(([key]) => key.startsWith(`${t.label}|`))
        .map(([key, amount]) => ({
          cost_element: t.label,
          document_type: key.slice(t.label.length + 1),
          amount,
        })));
    return { columns: ['cost_element', 'document_type', 'amount'], rows, rowCount: rows.length, ms: 0, truncated: false };
  }, [combos, maxGl]);

  return <Heatmap result={result} rowColumn="cost_element" colColumn="document_type" valueColumn="amount" />;
}

export function Settings() {
  const { projects, refresh } = useApp();
  const [info, setInfo] = useState<{ version: string; dbPath: string; userData: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ project_code: '', project_name: '', client_name: '', currency_code: 'USD', contract_value: '' });
  const [revenuePattern, setRevenuePattern] = useState('^4');

  const [combos, setCombos] = useState<CostTypeCombination[]>([]);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());

  const comboKey = (c: { cost_element_code: string; document_type: string }) =>
    `${c.cost_element_code} ${c.document_type}`;

  const loadCostTypes = async () => {
    const c = await api.costTypes.combinations();
    if (c.ok) setCombos(c.data);
  };

  /**
   * Every allocation saves the instant it is picked — no separate save step.
   * Combinations reload from the server afterwards rather than being patched
   * in place, so the "Now" badge and which pattern a cleared row falls back
   * to are always the server's real answer, not a guess made in the browser.
   */
  const allocate: AllocateFn = (items) => {
    const keys = items.map(comboKey);
    setSavingKeys((s) => new Set([...s, ...keys]));
    setError(null);
    (async () => {
      try {
        await call(api.costTypes.assign(items));
        await loadCostTypes();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSavingKeys((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n; });
      }
    })();
  };

  const exportMapping = () => guard(async () => {
    const path = await call(api.costTypes.exportMapping());
    setNote(path ? `Exported to ${path} — grouped by cost type, expand/collapse in Excel's own outline.`
      : 'Export cancelled.');
  });

  useEffect(() => {
    api.app.info().then((r) => { if (r.ok) setInfo(r.data); });
    api.settings.list().then((r) => {
      if (r.ok) setRevenuePattern(r.data.find((x) => x.key === 'revenue_account_pattern')?.value ?? '^4');
    });
    loadCostTypes();
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
        <h3>Allocate cost types</h3>
        <p className="hint">
          Every combination of cost element and document type that actually occurs in the cost
          already loaded — {combos.length} of them, grouped by their current cost type (UNMAPPED
          first) with each GL listed by description, not code. Pick one and it saves immediately —
          no re-import, nothing else to click — and the row moves into its new group as soon as
          the save comes back; <em>inherit</em> leaves it to whatever the account's own pattern
          already resolves to.
        </p>

        <GroupedAllocationTable combos={combos} savingKeys={savingKeys} allocate={allocate} comboKey={comboKey} />

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={exportMapping} disabled={busy}>
            ⤓ Export to Excel
          </button>
        </div>

        {combos.length > 0 && (
          <>
            <h4 style={{ marginTop: 18, marginBottom: 6 }}>GL × document type</h4>
            <p className="hint">
              Spend by document type against the biggest GLs, by description — an illustration, not
              a full report, capped to the 12 largest by spend.
            </p>
            <GlDocTypeMatrix combos={combos} />
          </>
        )}
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
