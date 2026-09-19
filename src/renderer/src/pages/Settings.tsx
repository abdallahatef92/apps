import { Fragment, useMemo, useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import type { CostType, CostTypeCombination, CostTypeDef, WorkPackage, WorkPackageCombination, WorkPackageDef } from '@shared/types';

const money = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 0 });

const lookupType = (types: CostTypeDef[], code: string) => types.find((t) => t.code === code);

/**
 * Assign a cost type with one click instead of a dropdown: a row of icon
 * buttons, filled in that type's colour when selected. `value` of '' or
 * undefined means "not set" — nothing is filled, and no clear button shows.
 * The buttons themselves come from dim_cost_type, not a hard-coded list, so a
 * type added from the manager above shows up here immediately.
 */
function CostTypePicker({ types, value, onChange, clearLabel = 'inherit' }: {
  types: CostTypeDef[];
  value: CostType | '';
  onChange: (v: CostType | '') => void;
  clearLabel?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {types.map((t) => {
        const selected = value === t.code;
        return (
          <button key={t.code} type="button" title={t.label}
                  onClick={() => onChange(selected ? '' : t.code)}
                  style={{
                    fontSize: 13, lineHeight: 1, padding: '4px 7px', borderRadius: 6,
                    cursor: 'pointer', fontFamily: 'inherit',
                    background: selected ? t.color : 'var(--surface-3)',
                    border: `1px solid ${selected ? t.color : 'var(--border)'}`,
                    filter: selected ? 'none' : 'grayscale(0.4) opacity(0.75)',
                  }}>
            {t.icon}
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
function CostTypeBadge({ types, type }: { types: CostTypeDef[]; type: string }) {
  const meta = lookupType(types, type);
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
function groupByCostType(combos: CostTypeCombination[], types: CostTypeDef[]): CostTypeGroup[] {
  const map = new Map<string, CostTypeGroup>();
  for (const c of combos) {
    const key = c.resolved_cost_type ?? 'UNMAPPED';
    const g = map.get(key) ?? { type: key, rows: [], postings: 0, amount: 0 };
    g.rows.push(c);
    g.postings += c.postings;
    g.amount += c.amount;
    map.set(key, g);
  }
  for (const g of map.values()) {
    g.rows.sort((a, b) =>
      glLabel(a).localeCompare(glLabel(b)) || a.document_type.localeCompare(b.document_type));
  }
  const order = ['UNMAPPED', ...types.map((t) => t.code)];
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
function GroupedAllocationTable({ combos, types, savingKeys, allocate, comboKey }: {
  combos: CostTypeCombination[];
  types: CostTypeDef[];
  savingKeys: Set<string>;
  allocate: AllocateFn;
  comboKey: (c: { cost_element_code: string; document_type: string }) => string;
}) {
  const groups = useMemo(() => groupByCostType(combos, types), [combos, types]);
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
                      : <CostTypeBadge types={types} type={g.type} />}
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
                    <CostTypePicker types={types} value={g.type === 'UNMAPPED' ? '' : g.type} clearLabel="per-row"
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
                            ? <CostTypeBadge types={types} type={c.resolved_cost_type} />
                            : <span className="faint mono">UNMAPPED</span>}
                          {!c.assigned_cost_type && c.resolved_cost_type && (
                            <span className="faint" style={{ fontSize: 10 }}>(pattern)</span>
                          )}
                          {saving && <span className="faint" style={{ fontSize: 10 }}>saving…</span>}
                        </div>
                      </td>
                      <td style={saving ? { opacity: .5, pointerEvents: 'none' } : undefined}>
                        <CostTypePicker types={types} value={c.assigned_cost_type ?? ''}
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
 * Manage the cost types themselves — rename, re-icon, re-colour, add, or (for
 * anything the user added) delete. The six built-in types can be edited but
 * not removed: the account-range rules and a lot of history name them by
 * code, and OTHER is the resolver's catch-all.
 */
function CostTypeManager({ types, onCreate, onUpdate, onDelete, busy }: {
  types: CostTypeDef[];
  onCreate: (input: { label: string; icon: string; color: string }) => void;
  onUpdate: (input: { code: string; label: string; icon: string; color: string }) => void;
  onDelete: (code: string) => void;
  busy: boolean;
}) {
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: '', icon: '', color: '' });
  const [newType, setNewType] = useState({ label: '', icon: '🏷️', color: '#8fa8f0' });

  const startEdit = (t: CostTypeDef) => {
    setEditingCode(t.code);
    setDraft({ label: t.label, icon: t.icon, color: t.color });
  };
  const saveEdit = () => {
    if (!editingCode) return;
    onUpdate({ code: editingCode, ...draft });
    setEditingCode(null);
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 60 }}>Icon</th>
            <th>Name</th>
            <th style={{ width: 90 }}>Colour</th>
            <th style={{ width: 90 }}>Kind</th>
            <th style={{ width: 170 }}></th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => {
            const editing = editingCode === t.code;
            return (
              <tr key={t.code}>
                <td style={{ textAlign: 'center', fontSize: 16 }}>
                  {editing
                    ? <input value={draft.icon} style={{ width: 44, textAlign: 'center' }}
                             onChange={(e) => setDraft((d) => ({ ...d, icon: e.target.value }))} />
                    : t.icon}
                </td>
                <td>
                  {editing
                    ? <input value={draft.label} style={{ width: '100%' }}
                             onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
                    : <CostTypeBadge types={types} type={t.code} />}
                </td>
                <td>
                  {editing
                    ? <input type="color" value={draft.color}
                             onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))} />
                    : <span style={{ display: 'inline-block', width: 18, height: 18, borderRadius: 4,
                                      background: t.color, verticalAlign: 'middle' }} />}
                </td>
                <td className="faint" style={{ fontSize: 11 }}>{t.is_system ? 'Built-in' : 'Custom'}</td>
                <td>
                  {editing ? (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm primary" onClick={saveEdit} disabled={busy}>Save</button>
                      <button className="btn sm ghost" onClick={() => setEditingCode(null)} disabled={busy}>Cancel</button>
                    </div>
                  ) : (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm" onClick={() => startEdit(t)} disabled={busy}>Edit</button>
                      {!t.is_system && (
                        <button className="btn sm ghost" onClick={() => onDelete(t.code)} disabled={busy}>Delete</button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          <tr>
            <td style={{ textAlign: 'center' }}>
              <input value={newType.icon} style={{ width: 44, textAlign: 'center' }}
                     onChange={(e) => setNewType((s) => ({ ...s, icon: e.target.value }))} />
            </td>
            <td>
              <input placeholder="New cost type name" style={{ width: '100%' }} value={newType.label}
                     onChange={(e) => setNewType((s) => ({ ...s, label: e.target.value }))} />
            </td>
            <td>
              <input type="color" value={newType.color}
                     onChange={(e) => setNewType((s) => ({ ...s, color: e.target.value }))} />
            </td>
            <td className="faint" style={{ fontSize: 11 }}>Custom</td>
            <td>
              <button className="btn sm primary" disabled={busy || !newType.label.trim()}
                      onClick={() => { onCreate(newType); setNewType({ label: '', icon: '🏷️', color: '#8fa8f0' }); }}>
                + Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const lookupWorkPackage = (types: WorkPackageDef[], code: string) => types.find((t) => t.code === code);

/** Same one-click assign pattern as CostTypePicker, over dim_work_package instead. */
function WorkPackagePicker({ types, value, onChange, clearLabel = 'inherit' }: {
  types: WorkPackageDef[];
  value: WorkPackage | '';
  onChange: (v: WorkPackage | '') => void;
  clearLabel?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {types.map((t) => {
        const selected = value === t.code;
        return (
          <button key={t.code} type="button" title={t.label}
                  onClick={() => onChange(selected ? '' : t.code)}
                  style={{
                    fontSize: 13, lineHeight: 1, padding: '4px 7px', borderRadius: 6,
                    cursor: 'pointer', fontFamily: 'inherit',
                    background: selected ? t.color : 'var(--surface-3)',
                    border: `1px solid ${selected ? t.color : 'var(--border)'}`,
                    filter: selected ? 'none' : 'grayscale(0.4) opacity(0.75)',
                  }}>
            {t.icon}
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

function WorkPackageBadge({ types, type }: { types: WorkPackageDef[]; type: string }) {
  const meta = lookupWorkPackage(types, type);
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

interface WorkPackageGroup {
  type: WorkPackage | 'UNALLOCATED';
  rows: WorkPackageCombination[];
  postings: number;
  amount: number;
}

const wbsLabel = (c: { wbs_code: string; wbs_name?: string | null }) =>
  c.wbs_name ? `${c.wbs_name} (${c.wbs_code})` : c.wbs_code || '(none)';

/** Same grouping shape as groupByCostType, keyed on the resolved work package. */
function groupByWorkPackage(combos: WorkPackageCombination[], types: WorkPackageDef[]): WorkPackageGroup[] {
  const map = new Map<string, WorkPackageGroup>();
  for (const c of combos) {
    const key = c.resolved_work_package ?? 'UNALLOCATED';
    const g = map.get(key) ?? { type: key, rows: [], postings: 0, amount: 0 };
    g.rows.push(c);
    g.postings += c.postings;
    g.amount += c.amount;
    map.set(key, g);
  }
  for (const g of map.values()) {
    g.rows.sort((a, b) => glLabel(a).localeCompare(glLabel(b)) || wbsLabel(a).localeCompare(wbsLabel(b)));
  }
  const order = ['UNALLOCATED', ...types.map((t) => t.code)];
  return [...map.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

type WorkPackageAllocateFn = (items: { cost_element_code: string; wbs_code: string; work_package: WorkPackage | null }[]) => void;

/** Mirrors GroupedAllocationTable, keyed on (cost element, WBS) instead of (cost element, document type). */
function GroupedWorkPackageAllocationTable({ combos, types, savingKeys, allocate, comboKey }: {
  combos: WorkPackageCombination[];
  types: WorkPackageDef[];
  savingKeys: Set<string>;
  allocate: WorkPackageAllocateFn;
  comboKey: (c: { cost_element_code: string; wbs_code: string }) => string;
}) {
  const groups = useMemo(() => groupByWorkPackage(combos, types), [combos, types]);
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
          {combos.length} combination{combos.length === 1 ? '' : 's'} across {groups.length} work package{groups.length === 1 ? '' : 's'}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 24 }}></th>
            <th>Work package / GL</th>
            <th>WBS</th>
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
                    {g.type === 'UNALLOCATED'
                      ? <span className="faint mono" style={{ fontWeight: 700 }}>UNALLOCATED</span>
                      : <WorkPackageBadge types={types} type={g.type} />}
                    <span className="faint" style={{ fontSize: 11, marginLeft: 8 }}>
                      {g.rows.length} GL/WBS combination{g.rows.length === 1 ? '' : 's'}
                    </span>
                    {groupSaving && <span className="faint" style={{ fontSize: 10, marginLeft: 8 }}>saving…</span>}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{g.postings.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(g.amount)}</td>
                  <td></td>
                  <td onClick={(e) => e.stopPropagation()}
                      style={groupSaving ? { opacity: .5, pointerEvents: 'none' } : undefined}>
                    <WorkPackagePicker types={types} value={g.type === 'UNALLOCATED' ? '' : g.type} clearLabel="per-row"
                      onChange={(v) => allocate(g.rows.map((r) => ({
                        cost_element_code: r.cost_element_code, wbs_code: r.wbs_code,
                        work_package: v || null,
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
                      <td className="mono faint">{wbsLabel(c)}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{c.postings.toLocaleString()}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{money(c.amount)}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {c.resolved_work_package
                            ? <WorkPackageBadge types={types} type={c.resolved_work_package} />
                            : <span className="faint mono">UNALLOCATED</span>}
                          {!c.assigned_work_package && c.resolved_work_package && (
                            <span className="faint" style={{ fontSize: 10 }}>(pattern)</span>
                          )}
                          {saving && <span className="faint" style={{ fontSize: 10 }}>saving…</span>}
                        </div>
                      </td>
                      <td style={saving ? { opacity: .5, pointerEvents: 'none' } : undefined}>
                        <WorkPackagePicker types={types} value={c.assigned_work_package ?? ''}
                          onChange={(v) => allocate([{
                            cost_element_code: c.cost_element_code, wbs_code: c.wbs_code,
                            work_package: v || null,
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

/** Mirrors CostTypeManager over dim_work_package — no built-in rows, so every one is deletable. */
function WorkPackageManager({ types, onCreate, onUpdate, onDelete, busy }: {
  types: WorkPackageDef[];
  onCreate: (input: { label: string; icon: string; color: string }) => void;
  onUpdate: (input: { code: string; label: string; icon: string; color: string }) => void;
  onDelete: (code: string) => void;
  busy: boolean;
}) {
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: '', icon: '', color: '' });
  const [newType, setNewType] = useState({ label: '', icon: '📦', color: '#8fa8f0' });

  const startEdit = (t: WorkPackageDef) => {
    setEditingCode(t.code);
    setDraft({ label: t.label, icon: t.icon, color: t.color });
  };
  const saveEdit = () => {
    if (!editingCode) return;
    onUpdate({ code: editingCode, ...draft });
    setEditingCode(null);
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 60 }}>Icon</th>
            <th>Name</th>
            <th style={{ width: 90 }}>Colour</th>
            <th style={{ width: 170 }}></th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => {
            const editing = editingCode === t.code;
            return (
              <tr key={t.code}>
                <td style={{ textAlign: 'center', fontSize: 16 }}>
                  {editing
                    ? <input value={draft.icon} style={{ width: 44, textAlign: 'center' }}
                             onChange={(e) => setDraft((d) => ({ ...d, icon: e.target.value }))} />
                    : t.icon}
                </td>
                <td>
                  {editing
                    ? <input value={draft.label} style={{ width: '100%' }}
                             onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
                    : <WorkPackageBadge types={types} type={t.code} />}
                </td>
                <td>
                  {editing
                    ? <input type="color" value={draft.color}
                             onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))} />
                    : <span style={{ display: 'inline-block', width: 18, height: 18, borderRadius: 4,
                                      background: t.color, verticalAlign: 'middle' }} />}
                </td>
                <td>
                  {editing ? (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm primary" onClick={saveEdit} disabled={busy}>Save</button>
                      <button className="btn sm ghost" onClick={() => setEditingCode(null)} disabled={busy}>Cancel</button>
                    </div>
                  ) : (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn sm" onClick={() => startEdit(t)} disabled={busy}>Edit</button>
                      <button className="btn sm ghost" onClick={() => onDelete(t.code)} disabled={busy}>Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          <tr>
            <td style={{ textAlign: 'center' }}>
              <input value={newType.icon} style={{ width: 44, textAlign: 'center' }}
                     onChange={(e) => setNewType((s) => ({ ...s, icon: e.target.value }))} />
            </td>
            <td>
              <input placeholder="New work package name" style={{ width: '100%' }} value={newType.label}
                     onChange={(e) => setNewType((s) => ({ ...s, label: e.target.value }))} />
            </td>
            <td>
              <input type="color" value={newType.color}
                     onChange={(e) => setNewType((s) => ({ ...s, color: e.target.value }))} />
            </td>
            <td>
              <button className="btn sm primary" disabled={busy || !newType.label.trim()}
                      onClick={() => { onCreate(newType); setNewType({ label: '', icon: '📦', color: '#8fa8f0' }); }}>
                + Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function Settings() {
  const { projects, refresh } = useApp();
  const [info, setInfo] = useState<{ version: string; dbPath: string; userData: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ project_code: '', project_name: '', client_name: '', currency_code: 'USD', contract_value: '' });

  const [types, setTypes] = useState<CostTypeDef[]>([]);
  const [combos, setCombos] = useState<CostTypeCombination[]>([]);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());

  const [wpTypes, setWpTypes] = useState<WorkPackageDef[]>([]);
  const [wpCombos, setWpCombos] = useState<WorkPackageCombination[]>([]);
  const [wpSavingKeys, setWpSavingKeys] = useState<Set<string>>(new Set());

  const comboKey = (c: { cost_element_code: string; document_type: string }) =>
    `${c.cost_element_code} ${c.document_type}`;
  const wpComboKey = (c: { cost_element_code: string; wbs_code: string }) =>
    `${c.cost_element_code} ${c.wbs_code}`;

  const loadCostTypes = async () => {
    const c = await api.costTypes.combinations();
    if (c.ok) setCombos(c.data);
  };
  const loadTypes = async () => {
    const r = await api.costTypes.types();
    if (r.ok) setTypes(r.data);
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

  const createType = (input: { label: string; icon: string; color: string }) => guard(async () => {
    setTypes(await call(api.costTypes.typeCreate(input)));
    setNote(`Added "${input.label}" as a cost type.`);
  });
  const updateType = (input: { code: string; label: string; icon: string; color: string }) => guard(async () => {
    setTypes(await call(api.costTypes.typeUpdate(input)));
    setNote(`"${input.label}" updated.`);
  });
  const deleteType = (code: string) => guard(async () => {
    setTypes(await call(api.costTypes.typeDelete(code)));
    setNote('Cost type removed.');
  });

  const exportMapping = () => guard(async () => {
    const path = await call(api.costTypes.exportMapping());
    setNote(path ? `Exported to ${path} — grouped by cost type, expand/collapse in Excel's own outline.`
      : 'Export cancelled.');
  });

  const loadWorkPackageCombos = async () => {
    const c = await api.workPackages.combinations();
    if (c.ok) setWpCombos(c.data);
  };
  const loadWorkPackageTypes = async () => {
    const r = await api.workPackages.types();
    if (r.ok) setWpTypes(r.data);
  };

  const allocateWorkPackage: WorkPackageAllocateFn = (items) => {
    const keys = items.map(wpComboKey);
    setWpSavingKeys((s) => new Set([...s, ...keys]));
    setError(null);
    (async () => {
      try {
        await call(api.workPackages.assign(items));
        await loadWorkPackageCombos();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setWpSavingKeys((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n; });
      }
    })();
  };

  const createWorkPackage = (input: { label: string; icon: string; color: string }) => guard(async () => {
    setWpTypes(await call(api.workPackages.typeCreate(input)));
    setNote(`Added "${input.label}" as a work package.`);
  });
  const updateWorkPackage = (input: { code: string; label: string; icon: string; color: string }) => guard(async () => {
    setWpTypes(await call(api.workPackages.typeUpdate(input)));
    setNote(`"${input.label}" updated.`);
  });
  const deleteWorkPackage = (code: string) => guard(async () => {
    setWpTypes(await call(api.workPackages.typeDelete(code)));
    setNote('Work package removed.');
  });

  useEffect(() => {
    api.app.info().then((r) => { if (r.ok) setInfo(r.data); });
    loadTypes();
    loadCostTypes();
    loadWorkPackageTypes();
    loadWorkPackageCombos();
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
        <h3>Cost types</h3>
        <p className="hint">
          The categories offered below in Allocate cost types. Rename or re-colour any of them, or
          add a new one — it shows up in the picker immediately, nothing to reload. The six built-in
          types can be edited but not deleted; anything added here can be removed once nothing is
          allocated to it.
        </p>
        <CostTypeManager types={types} onCreate={createType} onUpdate={updateType} onDelete={deleteType} busy={busy} />
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

        <GroupedAllocationTable combos={combos} types={types} savingKeys={savingKeys} allocate={allocate} comboKey={comboKey} />

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={exportMapping} disabled={busy}>
            ⤓ Export to Excel
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Work packages</h3>
        <p className="hint">
          A coding layer over actual/budget cost — masonry, concrete, earthwork, or whatever
          breakdown this project uses — entirely project-specific, so there is no default list
          the way cost types have. Define the ones this project needs, then allocate cost to
          them below.
        </p>
        <WorkPackageManager types={wpTypes} onCreate={createWorkPackage} onUpdate={updateWorkPackage}
          onDelete={deleteWorkPackage} busy={busy} />
      </div>

      <div className="card">
        <h3>Allocate work packages</h3>
        <p className="hint">
          Every combination of cost element and WBS that actually occurs in the cost already
          loaded — {wpCombos.length} of them, grouped by their current work package (UNALLOCATED
          first). Pick one and it saves immediately, the same way cost type allocation does;
          nothing coded yet stays UNALLOCATED rather than being guessed at.
        </p>

        <GroupedWorkPackageAllocationTable combos={wpCombos} types={wpTypes} savingKeys={wpSavingKeys}
          allocate={allocateWorkPackage} comboKey={wpComboKey} />
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
