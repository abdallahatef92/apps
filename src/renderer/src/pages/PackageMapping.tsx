import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, call } from '../lib/api';
import { SheetTabs } from '../components/SheetTabs';
import type {
  ElementPackageAssignment, MaterialPackageAssignment, MaterialPackageCombination, OtherPackageCombination,
  ServicePackageAssignment, ServicePackageCombination, WorkPackage, WorkPackageDef,
} from '@shared/types';

const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

const lookupPackage = (types: WorkPackageDef[], code: string) => types.find((t) => t.code === code);

/** GL description if the file gave one, falling back to the code alone. */
const glLabel = (c: { cost_element_code: string; cost_element_name?: string | null }) =>
  c.cost_element_name ? `${c.cost_element_name} (${c.cost_element_code})` : c.cost_element_code;

/** Material description if the file gave one, falling back to the code — or a placeholder if neither exists. */
const materialLabel = (c: { material_code: string | null; material_name?: string | null }) =>
  c.material_name ? `${c.material_name} (${c.material_code})` : (c.material_code ?? '(no material code)');

/**
 * Assign a work package with one click instead of a dropdown: a row of icon
 * buttons, filled in that package's colour when selected. Comes from
 * dim_work_package, not a hard-coded list, so a package added in the
 * Packages tab shows up here immediately.
 */
function PackagePicker({ types, value, onChange, clearLabel = 'clear' }: {
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
          <button key={t.code} type="button" title={`${t.code} — ${t.label}`}
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

function PackageBadge({ types, code }: { types: WorkPackageDef[]; code: string }) {
  const meta = lookupPackage(types, code);
  if (!meta) return <span className="faint mono">{code}</span>;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
      color: meta.color, background: `${meta.color}22`, border: `1px solid ${meta.color}55`,
      borderRadius: 5, padding: '2px 8px', whiteSpace: 'nowrap',
    }}>
      <span>{meta.icon}</span>{meta.code} — {meta.label}
    </span>
  );
}

interface Group<T> {
  code: WorkPackage | 'UNALLOCATED';
  rows: T[];
  postings: number;
  amount: number;
}

function groupByPackage<T extends { resolved_work_package: string | null; amount: number; postings: number }>(
  combos: T[], types: WorkPackageDef[], sortKey: (c: T) => string,
): Group<T>[] {
  const map = new Map<string, Group<T>>();
  for (const c of combos) {
    const key = c.resolved_work_package ?? 'UNALLOCATED';
    const g = map.get(key) ?? { code: key, rows: [], postings: 0, amount: 0 };
    g.rows.push(c);
    g.postings += c.postings;
    g.amount += c.amount;
    map.set(key, g);
  }
  for (const g of map.values()) g.rows.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const order = ['UNALLOCATED', ...types.map((t) => t.code)];
  return [...map.values()].sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
}

/**
 * The grouped-allocation-table shape shared by Materials/Subcontractors/Other:
 * one collapsible row per work package, its unique lines nested beneath.
 * Every picker here — a single row's or a whole group's — saves the instant
 * it is clicked; the row reappears under its new group once the save
 * round-trips. `renderKeyCell` draws the row's own identity (GL, or service
 * code/text) — the only thing that differs between the three tabs.
 */
function GroupedPackageTable<T extends { resolved_work_package: string | null; assigned_work_package: string | null; amount: number; postings: number }>({
  combos, types, savingKeys, onAllocate, rowKey, sortKey, keyColumnLabel, renderKeyCell, unitNoun,
}: {
  combos: T[];
  types: WorkPackageDef[];
  savingKeys: Set<string>;
  onAllocate: (rows: T[], value: WorkPackage | null) => void;
  rowKey: (c: T) => string;
  sortKey: (c: T) => string;
  keyColumnLabel: string;
  renderKeyCell: (c: T) => React.ReactNode;
  unitNoun: string;
}) {
  const groups = useMemo(() => groupByPackage(combos, types, sortKey), [combos, types]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [allCollapsed, setAllCollapsed] = useState(true);

  const isOpen = (code: string) => collapsed[code] !== undefined ? !collapsed[code] : !allCollapsed;
  const toggle = (code: string) => setCollapsed((c) => ({ ...c, [code]: isOpen(code) }));
  const expandAll = () => { setAllCollapsed(false); setCollapsed({}); };
  const collapseAll = () => { setAllCollapsed(true); setCollapsed({}); };

  return (
    <div className="table-wrap">
      <div className="row" style={{ marginBottom: 8, gap: 8 }}>
        <button className="btn sm" onClick={expandAll}>Expand all</button>
        <button className="btn sm" onClick={collapseAll}>Collapse all</button>
        <span className="faint" style={{ fontSize: 11, alignSelf: 'center' }}>
          {combos.length} {unitNoun}{combos.length === 1 ? '' : 's'} across {groups.length} work package{groups.length === 1 ? '' : 's'}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 24 }}></th>
            <th>Work package / {keyColumnLabel}</th>
            <th style={{ textAlign: 'right' }}>Postings</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
            <th style={{ width: 150 }}>Now</th>
            <th style={{ width: 240 }}>Allocate</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr><td colSpan={6}><div className="empty">No cost loaded yet.</div></td></tr>
          )}
          {groups.map((g) => {
            const open = isOpen(g.code);
            const groupSaving = g.rows.some((r) => savingKeys.has(rowKey(r)));
            return (
              <Fragment key={g.code}>
                <tr style={{ background: 'var(--surface-2)', cursor: 'pointer' }} onClick={() => toggle(g.code)}>
                  <td className="faint" style={{ textAlign: 'center' }}>{open ? '▾' : '▸'}</td>
                  <td>
                    {g.code === 'UNALLOCATED'
                      ? <span className="faint mono" style={{ fontWeight: 700 }}>UNALLOCATED</span>
                      : <PackageBadge types={types} code={g.code} />}
                    <span className="faint" style={{ fontSize: 11, marginLeft: 8 }}>
                      {g.rows.length} {unitNoun}{g.rows.length === 1 ? '' : 's'}
                    </span>
                    {groupSaving && <span className="faint" style={{ fontSize: 10, marginLeft: 8 }}>saving…</span>}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{g.postings.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(g.amount)}</td>
                  <td></td>
                  <td onClick={(e) => e.stopPropagation()}
                      style={groupSaving ? { opacity: .5, pointerEvents: 'none' } : undefined}>
                    <PackagePicker types={types} value={g.code === 'UNALLOCATED' ? '' : g.code} clearLabel="per-row"
                      onChange={(v) => onAllocate(g.rows, v || null)} />
                  </td>
                </tr>
                {open && g.rows.map((c) => {
                  const key = rowKey(c);
                  const saving = savingKeys.has(key);
                  return (
                    <tr key={key}>
                      <td></td>
                      <td className="mono" style={{ paddingLeft: 20 }}>{renderKeyCell(c)}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{c.postings.toLocaleString()}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{money(c.amount)}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {c.resolved_work_package
                            ? <PackageBadge types={types} code={c.resolved_work_package} />
                            : <span className="faint mono">UNALLOCATED</span>}
                          {!c.assigned_work_package && c.resolved_work_package && (
                            <span className="faint" style={{ fontSize: 10 }}>(default)</span>
                          )}
                          {saving && <span className="faint" style={{ fontSize: 10 }}>saving…</span>}
                        </div>
                      </td>
                      <td style={saving ? { opacity: .5, pointerEvents: 'none' } : undefined}>
                        <PackagePicker types={types} value={c.assigned_work_package ?? ''}
                          onChange={(v) => onAllocate([c], v || null)} />
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
 * Manage dim_work_package itself — code, name, group, icon, colour. Unlike
 * cost type, the code is typed directly (the budget file's own "Cost Code"
 * column states it) rather than derived from the label. INDIRECT is the
 * seeded, undeletable catch-all everything outside Material/Subcontract
 * defaults to.
 */
function PackageManager({ types, onCreate, onUpdate, onDelete, busy }: {
  types: WorkPackageDef[];
  onCreate: (input: { code: string; label: string; group_label: string; icon: string; color: string }) => void;
  onUpdate: (input: { code: string; label: string; group_label: string; icon: string; color: string }) => void;
  onDelete: (code: string) => void;
  busy: boolean;
}) {
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: '', group_label: '', icon: '', color: '' });
  const [newType, setNewType] = useState({ code: '', label: '', group_label: '', icon: '📦', color: '#8fa8f0' });

  const startEdit = (t: WorkPackageDef) => {
    setEditingCode(t.code);
    setDraft({ label: t.label, group_label: t.group_label ?? '', icon: t.icon, color: t.color });
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
            <th style={{ width: 100 }}>Code</th>
            <th>Name</th>
            <th>Group</th>
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
                <td className="mono">{t.code}</td>
                <td>
                  {editing
                    ? <input value={draft.label} style={{ width: '100%' }}
                             onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
                    : t.label}
                </td>
                <td className="faint">
                  {editing
                    ? <input value={draft.group_label} placeholder="e.g. Civil work Packages" style={{ width: '100%' }}
                             onChange={(e) => setDraft((d) => ({ ...d, group_label: e.target.value }))} />
                    : (t.group_label ?? '—')}
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
              <input placeholder="S.03" style={{ width: '100%' }} value={newType.code}
                     onChange={(e) => setNewType((s) => ({ ...s, code: e.target.value }))} />
            </td>
            <td>
              <input placeholder="Concrete" style={{ width: '100%' }} value={newType.label}
                     onChange={(e) => setNewType((s) => ({ ...s, label: e.target.value }))} />
            </td>
            <td>
              <input placeholder="Civil work Packages" style={{ width: '100%' }} value={newType.group_label}
                     onChange={(e) => setNewType((s) => ({ ...s, group_label: e.target.value }))} />
            </td>
            <td>
              <input type="color" value={newType.color}
                     onChange={(e) => setNewType((s) => ({ ...s, color: e.target.value }))} />
            </td>
            <td className="faint" style={{ fontSize: 11 }}>Custom</td>
            <td>
              <button className="btn sm primary" disabled={busy || !newType.code.trim() || !newType.label.trim()}
                      onClick={() => {
                        onCreate(newType);
                        setNewType({ code: '', label: '', group_label: '', icon: '📦', color: '#8fa8f0' });
                      }}>
                + Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Work-package coding — a dedicated page, not a Settings section, because
 * it's a recurring classification workflow (build the unique list, code
 * each one), not a one-time admin setting. Mirrors the real workflow: build
 * a package list, then code the unique materials and the unique
 * subcontractor service items into them — everything else defaults to
 * Indirect but stays visible here for review.
 */
export function PackageMapping() {
  const [types, setTypes] = useState<WorkPackageDef[]>([]);
  const [materials, setMaterials] = useState<MaterialPackageCombination[]>([]);
  const [other, setOther] = useState<OtherPackageCombination[]>([]);
  const [services, setServices] = useState<ServicePackageCombination[]>([]);
  const [savingMaterial, setSavingMaterial] = useState<Set<string>>(new Set());
  const [savingOther, setSavingOther] = useState<Set<string>>(new Set());
  const [savingService, setSavingService] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const loadTypes = async () => { const r = await api.workPackages.types(); if (r.ok) setTypes(r.data); };
  const loadMaterials = async () => { const r = await api.workPackages.materialCombinations(); if (r.ok) setMaterials(r.data); };
  const loadOther = async () => { const r = await api.workPackages.otherCombinations(); if (r.ok) setOther(r.data); };
  const loadServices = async () => { const r = await api.workPackages.serviceCombinations(); if (r.ok) setServices(r.data); };

  useEffect(() => { loadTypes(); loadMaterials(); loadOther(); loadServices(); }, []);

  const allocateElement = (
    rows: { cost_element_code: string }[], value: WorkPackage | null,
    setSaving: typeof setSavingOther, reload: () => Promise<void>,
  ) => {
    const keys = rows.map((r) => r.cost_element_code);
    setSaving((s) => new Set([...s, ...keys]));
    setError(null);
    (async () => {
      try {
        const items: ElementPackageAssignment[] = rows.map((r) => ({ cost_element_code: r.cost_element_code, work_package: value }));
        await call(api.workPackages.assignElement(items));
        await reload();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSaving((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n; });
      }
    })();
  };

  const allocateMaterial = (rows: MaterialPackageCombination[], value: WorkPackage | null) => {
    const keys = rows.map((r) => r.material_code ?? '');
    setSavingMaterial((s) => new Set([...s, ...keys]));
    setError(null);
    (async () => {
      try {
        const items: MaterialPackageAssignment[] = rows
          .filter((r): r is MaterialPackageCombination & { material_code: string } => !!r.material_code)
          .map((r) => ({ material_code: r.material_code, work_package: value }));
        if (items.length === 0) throw new Error('This line has no material code and cannot be coded directly.');
        await call(api.workPackages.assignMaterial(items));
        await loadMaterials();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSavingMaterial((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n; });
      }
    })();
  };

  const allocateService = (rows: ServicePackageCombination[], value: WorkPackage | null) => {
    const keys = rows.map((r) => `${r.service_code}\u0000${r.service_text}`);
    setSavingService((s) => new Set([...s, ...keys]));
    setError(null);
    (async () => {
      try {
        const items: ServicePackageAssignment[] = rows.map((r) => ({
          service_code: r.service_code, service_text: r.service_text, work_package: value,
        }));
        await call(api.workPackages.assignService(items));
        await loadServices();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSavingService((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n; });
      }
    })();
  };

  const createType = (input: { code: string; label: string; group_label: string; icon: string; color: string }) => guard(async () => {
    setTypes(await call(api.workPackages.typeCreate(input)));
    setNote(`Added "${input.code} — ${input.label}" as a work package.`);
  });
  const updateType = (input: { code: string; label: string; group_label: string; icon: string; color: string }) => guard(async () => {
    setTypes(await call(api.workPackages.typeUpdate(input)));
    setNote(`"${input.code}" updated.`);
  });
  const deleteType = (code: string) => guard(async () => {
    setTypes(await call(api.workPackages.typeDelete(code)));
    setNote('Work package removed.');
  });

  return (
    <>
      {error && <div className="banner err">{error}</div>}
      {note && <div className="banner ok">{note}</div>}

      <SheetTabs sheets={[
        {
          id: 'packages', label: 'Packages', content: (
            <div className="card">
              <h3>Work packages</h3>
              <p className="hint">
                The list of packages this project codes cost into — masonry, concrete, earthwork,
                or whatever breakdown fits — entirely project-specific, so there's no default list
                the way cost types have. The Code is the same short code the budget's own "Cost
                Code" column carries (e.g. "S.03"); Group is the free-text roll-up ("Civil work
                Packages") the report tables below group by. <strong>Indirect</strong> is the
                built-in catch-all everything outside Material/Subcontract defaults to.
              </p>
              <PackageManager types={types} onCreate={createType} onUpdate={updateType} onDelete={deleteType} busy={busy} />
            </div>
          ),
        },
        {
          id: 'materials', label: 'Materials', content: (
            <div className="card">
              <h3>Code materials into packages</h3>
              <p className="hint">
                Every real material — the SAP material number (MATNR), not the GL account, since
                several different materials commonly share one GL — that occurs in posted MATERIAL
                cost. {materials.length} of them, grouped by their current work package
                (UNALLOCATED first). Pick one and it saves immediately. A line with no material
                code (an older extract, or the column left blank) can't be coded until it has one.
              </p>
              <GroupedPackageTable combos={materials} types={types} savingKeys={savingMaterial}
                onAllocate={allocateMaterial}
                rowKey={(c) => c.material_code ?? `\u0000${c.material_name ?? ''}`} sortKey={materialLabel}
                keyColumnLabel="Material" renderKeyCell={(c) => materialLabel(c)} unitNoun="material" />
            </div>
          ),
        },
        {
          id: 'subcontractors', label: 'Subcontractors', content: (
            <div className="card">
              <h3>Code subcontractor service items into packages</h3>
              <p className="hint">
                Every unique (service code, service text) pair from the PO detail report — not the
                GL account the PO posts to, which is usually one generic subcontract account shared
                by many different service items. {services.length} of them, grouped by their
                current work package. A PO with no detail report loaded yet can't be coded here —
                it shows up as (unallocated) on the Cost Report until its detail is uploaded.
              </p>
              <GroupedPackageTable combos={services} types={types} savingKeys={savingService}
                onAllocate={allocateService}
                rowKey={(c) => `${c.service_code}\u0000${c.service_text}`}
                sortKey={(c) => c.service_text || c.service_code}
                keyColumnLabel="Service code / text"
                renderKeyCell={(c) => (
                  <>
                    <span>{c.service_text || '(no text)'}</span>
                    <span className="faint" style={{ marginLeft: 6 }}>{c.service_code || '(no code)'}</span>
                  </>
                )}
                unitNoun="service item" />
            </div>
          ),
        },
        {
          id: 'other', label: 'Other (auto-indirect)', content: (
            <div className="card">
              <h3>Review the rest</h3>
              <p className="hint">
                Every cost element outside Material/Subcontract — labor, equipment, and anything
                else — defaults straight to <strong>Indirect</strong>, but stays listed here so any
                of it that's really package work miscoded under another cost type can still be
                pulled out. {other.length} of them.
              </p>
              <GroupedPackageTable combos={other} types={types} savingKeys={savingOther}
                onAllocate={(rows, v) => allocateElement(rows, v, setSavingOther, loadOther)}
                rowKey={(c) => c.cost_element_code} sortKey={glLabel}
                keyColumnLabel="GL" renderKeyCell={(c) => (
                  <>
                    {glLabel(c)}
                    <span className="faint" style={{ marginLeft: 6 }}>{c.cost_type ?? ''}</span>
                  </>
                )} unitNoun="cost element" />
            </div>
          ),
        },
      ]} />
    </>
  );
}
