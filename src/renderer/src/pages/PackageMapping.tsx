import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, call } from '../lib/api';
import { SheetTabs } from '../components/SheetTabs';
import type {
  ElementPackageAssignment, MaterialImportResult, MaterialPackageAssignment, MaterialPackageCombination,
  OtherPackageCombination, ServicePackageAssignment, ServicePackageCombination, WorkPackage, WorkPackageDef,
} from '@shared/types';

const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

const lookupPackage = (types: WorkPackageDef[], code: string) => types.find((t) => t.code === code);

/** GL description if the file gave one, falling back to the code alone. */
const glLabel = (c: { cost_element_code: string; cost_element_name?: string | null }) =>
  c.cost_element_name ? `${c.cost_element_name} (${c.cost_element_code})` : c.cost_element_code;

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
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 12, lineHeight: 1, padding: '4px 7px', borderRadius: 6,
                    cursor: 'pointer', fontFamily: 'inherit',
                    background: selected ? t.color : 'var(--surface-3)',
                    border: `1px solid ${selected ? t.color : 'var(--border)'}`,
                    filter: selected ? 'none' : 'grayscale(0.4) opacity(0.75)',
                  }}>
            <span style={{ fontSize: 10 }}>{t.icon}</span>{t.code}
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

/** The unallocated equivalent of PackageBadge — same pill shape, warning-tinted rather than a package's own color, so an uncoded row reads as "unresolved" rather than just plainer text. */
function UnallocatedBadge() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 600,
      color: 'var(--warning)', background: '#fab21922', border: '1px solid #fab21955',
      borderRadius: 5, padding: '2px 8px', whiteSpace: 'nowrap',
    }}>
      UNALLOCATED
    </span>
  );
}

/** Small coded/uncoded fill — a scanning aid next to a group's own count, not a chart: one fill (severity color), track is the same color at low alpha rather than a second hue. Shared by every grouped-picker table on this page. */
function CoverageMeter({ coded, total }: { coded: number; total: number }) {
  const donePct = total > 0 ? (coded / total) * 100 : 0;
  // Actual hex, not var(--good)/var(--warning) — a CSS variable can't be
  // alpha-suffixed the way PackageBadge tints a data-driven hex color.
  const color = coded === total ? '#0ca30c' : '#fab219';
  return (
    <span title={`${coded} of ${total} coded`}
          style={{ display: 'inline-block', width: 44, height: 6, borderRadius: 3,
                   background: `${color}33`, verticalAlign: 'middle', marginLeft: 8, overflow: 'hidden' }}>
      <span style={{ display: 'block', width: `${donePct}%`, height: '100%', background: color, borderRadius: 3 }} />
    </span>
  );
}

function PackageBadge({ types, code }: { types: WorkPackageDef[]; code: string }) {
  const meta = lookupPackage(types, code);
  if (!meta) return <span className="faint mono">{code}</span>;
  return (
    <span title={meta.label} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
      color: meta.color, background: `${meta.color}22`, border: `1px solid ${meta.color}55`,
      borderRadius: 5, padding: '2px 8px', whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 9 }}>{meta.icon}</span>{meta.code}
    </span>
  );
}

interface Group<T> {
  key: string;
  rows: T[];
  postings: number;
  amount: number;
}

type PkgSortCol = 'key' | 'postings' | 'amount';
/** 'key' = the caller's own grouping dimension (only offered when `groupKey` is supplied), 'package' = by current resolved package (the only dimension when `groupKey` isn't supplied), 'none' = flat. */
type PkgGroupBy = 'key' | 'package' | 'none';

function buildGenericGroups<T extends { resolved_work_package: string | null; amount: number; postings: number }>(
  rows: T[], groupBy: 'key' | 'package', keyOf: (c: T) => string, types: WorkPackageDef[],
  sort: { col: PkgSortCol; dir: 1 | -1 },
): Group<T>[] {
  const map = new Map<string, Group<T>>();
  for (const r of rows) {
    const key = groupBy === 'key' ? keyOf(r) : (r.resolved_work_package ?? 'UNALLOCATED');
    const g = map.get(key) ?? { key, rows: [], postings: 0, amount: 0 };
    g.rows.push(r);
    g.postings += r.postings;
    g.amount += r.amount;
    map.set(key, g);
  }
  // A click on Amount/Postings reorders the groups themselves, not just the
  // rows inside each one — see buildMaterialGroups() for the same reasoning.
  // Every other sort column keeps identity ordering (CSI order for a
  // package group, alphanumeric otherwise), since a group has no single
  // code/description of its own to rank by.
  if (sort.col === 'postings' || sort.col === 'amount') {
    const col = sort.col;
    for (const g of map.values()) g.rows.sort((a, b) => (a[col] - b[col]) * sort.dir);
    return [...map.values()].sort((a, b) => (a[col] - b[col]) * sort.dir);
  }
  if (groupBy === 'package') {
    const order = ['UNALLOCATED', ...types.map((t) => t.code)];
    return [...map.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/**
 * The grouped-allocation-table shape shared by Subcontractors/Other: one
 * collapsible row per group, its unique lines nested beneath. Mirrors
 * `MaterialCodingTable`'s own shape (checkbox rows, one sticky toolbar
 * picker, sortable columns, code/description as two real columns,
 * unallocated visual treatment) rather than carrying its own separate,
 * older pattern. `groupKey`/`groupKeyLabel` are optional — when supplied
 * (Subcontractors: the service code's own prefix), the table gets the same
 * two-level `groupBy1`/`groupBy2` selector Materials has; when omitted
 * (Other), it keeps a single grouping by current package, unchanged.
 */
function GroupedPackageTable<T extends { resolved_work_package: string | null; assigned_work_package: string | null; amount: number; postings: number }>({
  combos, types, savingKeys, onAllocate, rowKey, sortKey, codeLabel, renderCode, descLabel, renderDescription,
  unitNoun, groupKey, groupKeyLabel,
}: {
  combos: T[];
  types: WorkPackageDef[];
  savingKeys: Set<string>;
  onAllocate: (rows: T[], value: WorkPackage | null) => void;
  rowKey: (c: T) => string;
  sortKey: (c: T) => string;
  codeLabel: string;
  renderCode: (c: T) => React.ReactNode;
  descLabel: string;
  renderDescription: (c: T) => React.ReactNode;
  unitNoun: string;
  groupKey?: (c: T) => string;
  groupKeyLabel?: string;
}) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ col: PkgSortCol; dir: 1 | -1 }>({ col: 'amount', dir: -1 });
  const [groupBy1, setGroupBy1] = useState<PkgGroupBy>(groupKey ? 'key' : 'package');
  const [groupBy2, setGroupBy2] = useState<PkgGroupBy>('none');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [allCollapsed, setAllCollapsed] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const selBarRef = useRef<HTMLDivElement>(null);
  const [selBarHeight, setSelBarHeight] = useState(0);
  useEffect(() => {
    const el = selBarRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSelBarHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return combos;
    return combos.filter((c) => sortKey(c).toLowerCase().includes(f));
  }, [combos, filter, sortKey]);

  // groupBy2 only makes sense as a second, different dimension — same rule
  // MaterialCodingTable applies.
  const effectiveGroupBy2: PkgGroupBy = groupBy1 === 'none' || groupBy2 === groupBy1 ? 'none' : groupBy2;

  const groups = useMemo(
    () => (groupBy1 === 'none' ? null : buildGenericGroups(filtered, groupBy1, groupKey ?? (() => ''), types, sort)),
    [filtered, groupBy1, groupKey, types, sort],
  );
  const grandTotal = useMemo(() => combos.reduce((s, c) => s + c.amount, 0), [combos]);
  const unallocated = useMemo(() => combos.filter((c) => !c.resolved_work_package), [combos]);
  const pct = (amount: number) => (grandTotal > 0 ? ((amount / grandTotal) * 100).toFixed(1) : '0.0');

  const isOpen = (key: string) => collapsed[key] !== undefined ? !collapsed[key] : !allCollapsed;
  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: isOpen(key) }));
  const expandAll = () => { setAllCollapsed(false); setCollapsed({}); };
  const collapseAll = () => { setAllCollapsed(true); setCollapsed({}); };

  const toggleSort = (col: PkgSortCol) =>
    setSort((s) => (s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: col === 'key' ? 1 : -1 }));
  const sortArrow = (col: PkgSortCol) => (sort.col === col ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');

  const selectionState = (rows: T[]): 'all' | 'some' | 'none' => {
    const n = rows.filter((r) => selected.has(rowKey(r))).length;
    return n === 0 ? 'none' : n === rows.length ? 'all' : 'some';
  };
  const setRowsSelected = (rows: T[], checked: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const r of rows) checked ? next.add(rowKey(r)) : next.delete(rowKey(r));
      return next;
    });
  const toggleRow = (key: string, checked: boolean) =>
    setSelected((s) => { const next = new Set(s); checked ? next.add(key) : next.delete(key); return next; });

  const groupByOptionLabels: Record<PkgGroupBy, string> = {
    key: groupKeyLabel ?? 'Key', package: 'Current work package', none: 'None',
  };
  const groupByOptions = (exclude?: PkgGroupBy) =>
    (['key', 'package', 'none'] as PkgGroupBy[])
      .filter((v) => v !== 'key' || !!groupKey)
      .filter((v) => v !== exclude)
      .map((v) => <option key={v} value={v}>{groupByOptionLabels[v]}</option>);

  const groupLabel = (kind: 'key' | 'package', key: string) =>
    kind === 'package'
      ? (key === 'UNALLOCATED' ? <UnallocatedBadge /> : <PackageBadge types={types} code={key} />)
      : <span className="mono" style={{ fontWeight: 700 }}>{key}*</span>;

  const renderRow = (c: T, depth: number) => {
    const key = rowKey(c);
    const saving = savingKeys.has(key);
    return (
      <tr key={key} style={saving ? { opacity: .5 } : undefined}>
        <td style={{ textAlign: 'center' }}>
          <input type="checkbox" checked={selected.has(key)} onChange={(e) => toggleRow(key, e.target.checked)} />
        </td>
        <td className="mono" style={{ paddingLeft: depth ? depth * 20 : undefined }}>{renderCode(c)}</td>
        <td>{renderDescription(c)}</td>
        <td className="mono" style={{ textAlign: 'right' }}>{c.postings.toLocaleString()}</td>
        <td className="mono" style={{ textAlign: 'right' }}>{money(c.amount)}</td>
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {c.resolved_work_package
              ? <PackageBadge types={types} code={c.resolved_work_package} />
              : <UnallocatedBadge />}
            {!c.assigned_work_package && c.resolved_work_package && (
              <span className="faint" style={{ fontSize: 10 }}>(default)</span>
            )}
            {c.assigned_work_package && (
              <button type="button" title="Clear this row's allocation" onClick={() => onAllocate([c], null)}
                      style={{ fontSize: 10, padding: '2px 5px', borderRadius: 5, cursor: 'pointer',
                               fontFamily: 'inherit', background: 'transparent', color: 'var(--text-3)',
                               border: '1px solid var(--border)' }}>
                ✕
              </button>
            )}
            {saving && <span className="faint" style={{ fontSize: 10 }}>saving…</span>}
          </div>
        </td>
      </tr>
    );
  };

  const renderGroupHeader = (g: Group<T>, kind: 'key' | 'package', collapseKey: string, depth: number) => {
    const open = isOpen(collapseKey);
    const groupSaving = g.rows.some((r) => savingKeys.has(rowKey(r)));
    const groupUnallocated = g.rows.filter((r) => !r.resolved_work_package).length;
    return (
      <tr key={collapseKey} style={{ background: depth ? 'var(--surface-1)' : 'var(--surface-2)', cursor: 'pointer' }}
          onClick={() => toggle(collapseKey)}>
        <td style={{ textAlign: 'center', verticalAlign: 'top' }} onClick={(e) => e.stopPropagation()}>
          <TriCheckbox state={selectionState(g.rows)} onChange={(checked) => setRowsSelected(g.rows, checked)}
                       title="Select all rows in this group" />
        </td>
        <td colSpan={2} style={{ paddingLeft: depth ? depth * 20 : undefined, verticalAlign: 'top' }}>
          <span style={{ marginRight: 6 }}>{open ? '▾' : '▸'}</span>
          {groupLabel(kind, g.key)}
          <span className="faint" style={{ fontSize: 11, marginLeft: 8 }}>
            {g.rows.length} {unitNoun}{g.rows.length === 1 ? '' : 's'}
            {groupUnallocated > 0 && (
              <span style={{ color: 'var(--warning)' }}> · {groupUnallocated} unallocated</span>
            )}
          </span>
          <CoverageMeter coded={g.rows.length - groupUnallocated} total={g.rows.length} />
          {groupSaving && <span className="faint" style={{ fontSize: 10, marginLeft: 8 }}>saving…</span>}
        </td>
        <td className="mono" style={{ textAlign: 'right', verticalAlign: 'top' }}>{g.postings.toLocaleString()}</td>
        <td className="mono" style={{ textAlign: 'right', verticalAlign: 'top' }}>{money(g.amount)}</td>
        <td style={{ verticalAlign: 'top' }}></td>
      </tr>
    );
  };

  return (
    <div className="table-wrap" style={{ overflow: 'visible' }}>
      <div className="row" style={{ marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <input placeholder={`Filter ${codeLabel.toLowerCase()} or ${descLabel.toLowerCase()}…`} value={filter}
               onChange={(e) => setFilter(e.target.value)} style={{ width: 240 }} />
        {groupKey && (
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <span className="faint" style={{ fontSize: 12 }}>Group by</span>
            <select value={groupBy1} onChange={(e) => { setGroupBy1(e.target.value as PkgGroupBy); setCollapsed({}); }}>
              {groupByOptions()}
            </select>
          </label>
        )}
        {groupKey && groupBy1 !== 'none' && (
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <span className="faint" style={{ fontSize: 12 }}>Then by</span>
            <select value={effectiveGroupBy2} onChange={(e) => { setGroupBy2(e.target.value as PkgGroupBy); setCollapsed({}); }}>
              {groupByOptions(groupBy1)}
            </select>
          </label>
        )}
        {groups && (
          <>
            <button className="btn sm" onClick={expandAll}>Expand all</button>
            <button className="btn sm" onClick={collapseAll}>Collapse all</button>
          </>
        )}
        <span className="faint" style={{ fontSize: 11, alignSelf: 'center' }}>
          {filtered.length} of {combos.length} {unitNoun}{combos.length === 1 ? '' : 's'}
          {groups && ` across ${groups.length} group${groups.length === 1 ? '' : 's'}`}
          {' · '}
          <span style={{ color: 'var(--warning)' }}>
            {unallocated.length} unallocated ({pct(unallocated.reduce((s, c) => s + c.amount, 0))}% of total)
          </span>
        </span>
      </div>
      <div className="sel-bar" ref={selBarRef}>
        {selected.size > 0 ? (
          <>
            <strong style={{ fontSize: 12 }}>{selected.size} selected</strong>
            <PackagePicker types={types} value="" clearLabel="selection"
              onChange={(v) => {
                if (!v) return;
                const rows = filtered.filter((r) => selected.has(rowKey(r)));
                onAllocate(rows, v);
                setSelected(new Set());
              }} />
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
          </>
        ) : (
          <span className="faint" style={{ fontSize: 12 }}>
            Select rows to assign a package to several at once.
          </span>
        )}
      </div>
      <table style={{ '--sel-bar-h': `${selBarHeight}px` } as React.CSSProperties}>
        <thead className="pkg-sticky-thead">
          <tr>
            <th style={{ width: 28, textAlign: 'center' }}>
              <TriCheckbox state={selectionState(filtered)} onChange={(checked) => setRowsSelected(filtered, checked)}
                           title="Select all visible rows" />
            </th>
            <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('key')}>{codeLabel}{sortArrow('key')}</th>
            <th>{descLabel}</th>
            <th style={{ textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('postings')}>
              Postings{sortArrow('postings')}
            </th>
            <th style={{ textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('amount')}>
              Amount{sortArrow('amount')}
            </th>
            <th style={{ width: 150 }}>Now</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr><td colSpan={6}><div className="empty">No cost loaded yet.</div></td></tr>
          )}
          {groups ? groups.map((g) => {
            const open = isOpen(g.key);
            const subGroups = effectiveGroupBy2 === 'none' ? null
              : buildGenericGroups(g.rows, effectiveGroupBy2 as 'key' | 'package', groupKey ?? (() => ''), types, sort);
            return (
              <Fragment key={g.key}>
                {renderGroupHeader(g, groupBy1 as 'key' | 'package', g.key, 0)}
                {open && (subGroups
                  ? subGroups.map((sg) => {
                      const subKey = `${g.key}::${sg.key}`;
                      const subOpen = isOpen(subKey);
                      return (
                        <Fragment key={subKey}>
                          {renderGroupHeader(sg, effectiveGroupBy2 as 'key' | 'package', subKey, 1)}
                          {subOpen && sg.rows.map((c) => renderRow(c, 2))}
                        </Fragment>
                      );
                    })
                  : g.rows.map((c) => renderRow(c, 1)))}
              </Fragment>
            );
          }) : filtered.map((c) => renderRow(c, 0))}
        </tbody>
      </table>
    </div>
  );
}

type MaterialSortCol = 'material_code' | 'material_name' | 'prefix' | 'postings' | 'amount';
type MaterialGroupKind = 'prefix' | 'package';
type MaterialGroupBy = MaterialGroupKind | 'none';

interface MaterialGroup {
  key: string;
  rows: MaterialPackageCombination[];
  postings: number;
  amount: number;
  /** The one package every row in this group already shares, or '' if mixed/none — the bulk picker's current value. */
  uniformPackage: WorkPackage | '';
}

function buildMaterialGroups(
  rows: MaterialPackageCombination[], groupBy: MaterialGroupKind, types: WorkPackageDef[],
  sort: { col: MaterialSortCol; dir: 1 | -1 },
): MaterialGroup[] {
  const map = new Map<string, MaterialGroup>();
  for (const r of rows) {
    const key = groupBy === 'prefix' ? r.prefix : (r.resolved_work_package ?? 'UNALLOCATED');
    const g = map.get(key) ?? { key, rows: [], postings: 0, amount: 0, uniformPackage: '' as WorkPackage | '' };
    g.rows.push(r);
    g.postings += r.postings;
    g.amount += r.amount;
    map.set(key, g);
  }
  for (const g of map.values()) {
    const first = g.rows[0]?.resolved_work_package ?? null;
    g.uniformPackage = first && g.rows.every((r) => r.resolved_work_package === first) ? first : '';
  }
  // A click on Amount/Postings should reorder the groups themselves, not
  // just the rows inside each one — otherwise the header's sort arrow
  // claims an order the group list doesn't actually show. Every other
  // sort column falls back to identity ordering (CSI order for a package
  // group, numeric prefix order otherwise), since a group has no single
  // code/description of its own to sort by.
  if (sort.col === 'amount' || sort.col === 'postings') {
    const col = sort.col;
    return [...map.values()].sort((a, b) => (a[col] - b[col]) * sort.dir);
  }
  if (groupBy === 'package') {
    const order = ['UNALLOCATED', ...types.map((t) => t.code)];
    return [...map.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/**
 * The Materials tab's own table — 500+ rows in a real project, so it needs
 * what GroupedPackageTable (fine for the much shorter Subcontractors/Other
 * lists) doesn't have: a text filter, sortable columns, code and description
 * as two real columns (never merged), and a second grouping dimension —
 * the material code's first two digits, which real SAP numbering uses for
 * category — so a bulk pick on one group header codes dozens of materials
 * in one click instead of one at a time.
 */
/** A checkbox that can also render the "some but not all" indeterminate state — plain <input> has no prop for that, only a DOM property. */
function TriCheckbox({ state, onChange, title }: { state: 'all' | 'some' | 'none'; onChange: (checked: boolean) => void; title?: string }) {
  return (
    <input type="checkbox" title={title} checked={state === 'all'}
           ref={(el) => { if (el) el.indeterminate = state === 'some'; }}
           onChange={(e) => onChange(e.target.checked)} />
  );
}

function MaterialCodingTable({ combos, types, savingKeys, onAllocate }: {
  combos: MaterialPackageCombination[];
  types: WorkPackageDef[];
  savingKeys: Set<string>;
  onAllocate: (rows: MaterialPackageCombination[], value: WorkPackage | null) => void;
}) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ col: MaterialSortCol; dir: 1 | -1 }>({ col: 'amount', dir: -1 });
  const [groupBy1, setGroupBy1] = useState<MaterialGroupBy>('prefix');
  const [groupBy2, setGroupBy2] = useState<MaterialGroupBy>('none');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [allCollapsed, setAllCollapsed] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // The column-header row sticks directly below this bar, whatever height it
  // actually renders at — it can wrap to more than one line depending on
  // window width and how many work packages exist, so the offset is measured
  // rather than a hardcoded constant (see `--sel-bar-h` in styles.css).
  const selBarRef = useRef<HTMLDivElement>(null);
  const [selBarHeight, setSelBarHeight] = useState(0);
  useEffect(() => {
    const el = selBarRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSelBarHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return combos;
    return combos.filter((c) =>
      c.material_code.toLowerCase().includes(f) || (c.material_name ?? '').toLowerCase().includes(f));
  }, [combos, filter]);

  const sorted = useMemo(() => {
    const { col, dir } = sort;
    return [...filtered].sort((a, b) => {
      const x = a[col], y = b[col];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true }) * dir;
    });
  }, [filtered, sort]);

  const toggleSort = (col: MaterialSortCol) =>
    setSort((s) => (s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: col === 'amount' || col === 'postings' ? -1 : 1 }));

  // groupBy2 only makes sense as a second, different dimension — picking the
  // same one as groupBy1 (or picking a second level with no first level)
  // collapses back to a single level rather than showing a pointless one-item nesting.
  const effectiveGroupBy2: MaterialGroupBy = groupBy1 === 'none' || groupBy2 === groupBy1 ? 'none' : groupBy2;

  const groups = useMemo(
    () => (groupBy1 === 'none' ? null : buildMaterialGroups(sorted, groupBy1, types, sort)),
    [sorted, groupBy1, types, sort],
  );

  const isOpen = (key: string) => collapsed[key] !== undefined ? !collapsed[key] : !allCollapsed;
  const toggleGroup = (key: string) => setCollapsed((c) => ({ ...c, [key]: isOpen(key) }));
  const expandAll = () => { setAllCollapsed(false); setCollapsed({}); };
  const collapseAll = () => { setAllCollapsed(true); setCollapsed({}); };

  const sortArrow = (col: MaterialSortCol) => (sort.col === col ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');

  // Denominator/whole-tab aggregates for the "% of total" and "unallocated"
  // indicators — computed over the full unfiltered list, matching how the
  // existing "X of Y materials" count already reasons about the whole tab.
  const grandTotal = useMemo(() => combos.reduce((s, c) => s + c.amount, 0), [combos]);
  const unallocated = useMemo(() => combos.filter((c) => !c.resolved_work_package), [combos]);
  const unallocatedAmount = useMemo(() => unallocated.reduce((s, c) => s + c.amount, 0), [unallocated]);
  const pct = (amount: number) => (grandTotal > 0 ? ((amount / grandTotal) * 100).toFixed(1) : '0.0');

  const selectionState = (rows: MaterialPackageCombination[]): 'all' | 'some' | 'none' => {
    const n = rows.filter((r) => selected.has(r.material_code)).length;
    return n === 0 ? 'none' : n === rows.length ? 'all' : 'some';
  };
  const setRowsSelected = (rows: MaterialPackageCombination[], checked: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const r of rows) checked ? next.add(r.material_code) : next.delete(r.material_code);
      return next;
    });
  const toggleRow = (code: string, checked: boolean) =>
    setSelected((s) => { const next = new Set(s); checked ? next.add(code) : next.delete(code); return next; });

  const groupLabel = (kind: MaterialGroupKind, key: string) =>
    kind === 'package'
      ? (key === 'UNALLOCATED' ? <UnallocatedBadge /> : <PackageBadge types={types} code={key} />)
      : <span className="mono" style={{ fontWeight: 700 }}>{key}xxxxx</span>;

  const renderRow = (c: MaterialPackageCombination, depth: number) => {
    const key = c.material_code;
    const saving = savingKeys.has(key);
    return (
      <tr key={key} style={saving ? { opacity: .5 } : undefined}>
        <td style={{ textAlign: 'center' }}>
          <input type="checkbox" checked={selected.has(key)} onChange={(e) => toggleRow(key, e.target.checked)} />
        </td>
        <td className="mono" style={{ paddingLeft: depth ? depth * 20 : undefined }}>{c.material_code}</td>
        <td>{c.material_name ?? <span className="faint">—</span>}</td>
        <td className="mono faint">{c.prefix}</td>
        <td className="mono" style={{ textAlign: 'right' }}>{c.postings.toLocaleString()}</td>
        <td className="mono" style={{ textAlign: 'right' }}>{money(c.amount)}</td>
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {c.resolved_work_package
              ? <PackageBadge types={types} code={c.resolved_work_package} />
              : <UnallocatedBadge />}
            {!c.assigned_work_package && c.resolved_work_package && (
              <span className="faint" style={{ fontSize: 10 }}>(default)</span>
            )}
            {c.assigned_work_package && (
              <button type="button" title="Clear this row's allocation" onClick={() => onAllocate([c], null)}
                      style={{ fontSize: 10, padding: '2px 5px', borderRadius: 5, cursor: 'pointer',
                               fontFamily: 'inherit', background: 'transparent', color: 'var(--text-3)',
                               border: '1px solid var(--border)' }}>
                ✕
              </button>
            )}
            {saving && <span className="faint" style={{ fontSize: 10 }}>saving…</span>}
          </div>
        </td>
      </tr>
    );
  };

  /** One collapsible group header, at either nesting level — a bulk picker scoped to just this group's rows. */
  const renderGroupHeader = (g: MaterialGroup, kind: MaterialGroupKind, collapseKey: string, depth: number) => {
    const open = isOpen(collapseKey);
    const groupSaving = g.rows.some((r) => savingKeys.has(r.material_code));
    const groupUnallocated = g.rows.filter((r) => !r.resolved_work_package).length;
    return (
      <tr key={collapseKey} style={{ background: depth ? 'var(--surface-1)' : 'var(--surface-2)', cursor: 'pointer' }}
          onClick={() => toggleGroup(collapseKey)}>
        <td style={{ textAlign: 'center', verticalAlign: 'top' }} onClick={(e) => e.stopPropagation()}>
          <TriCheckbox state={selectionState(g.rows)} onChange={(checked) => setRowsSelected(g.rows, checked)}
                       title="Select all rows in this group" />
        </td>
        <td colSpan={2} style={{ paddingLeft: depth ? depth * 20 : undefined, verticalAlign: 'top' }}>
          <span style={{ marginRight: 6 }}>{open ? '▾' : '▸'}</span>
          {groupLabel(kind, g.key)}
          <span className="faint" style={{ fontSize: 11, marginLeft: 8 }}>
            {g.rows.length} material{g.rows.length === 1 ? '' : 's'}
            {groupUnallocated > 0 && (
              <span style={{ color: 'var(--warning)' }}> · {groupUnallocated} unallocated</span>
            )}
            {' · '}{pct(g.amount)}% of total
          </span>
          <CoverageMeter coded={g.rows.length - groupUnallocated} total={g.rows.length} />
          {groupSaving && <span className="faint" style={{ fontSize: 10, marginLeft: 8 }}>saving…</span>}
        </td>
        <td style={{ verticalAlign: 'top' }}></td>
        <td className="mono" style={{ textAlign: 'right', verticalAlign: 'top' }}>{g.postings.toLocaleString()}</td>
        <td className="mono" style={{ textAlign: 'right', verticalAlign: 'top' }}>{money(g.amount)}</td>
        <td style={{ verticalAlign: 'top' }}></td>
      </tr>
    );
  };

  const headerCell = (label: string, col: MaterialSortCol, style?: React.CSSProperties) => (
    <th style={{ cursor: 'pointer', ...style }} onClick={() => toggleSort(col)}>{label}{sortArrow(col)}</th>
  );

  const groupByOptionLabels: Record<MaterialGroupBy, string> = {
    prefix: 'Code prefix (first 2 digits)', package: 'Current work package', none: 'None',
  };
  const groupByOptions = (exclude?: MaterialGroupBy) =>
    (['prefix', 'package', 'none'] as MaterialGroupBy[])
      .filter((v) => v !== exclude)
      .map((v) => <option key={v} value={v}>{groupByOptionLabels[v]}</option>);

  return (
    <div className="table-wrap" style={{ overflow: 'visible' }}>
      <div className="row" style={{ marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <input placeholder="Filter code or description…" value={filter}
               onChange={(e) => setFilter(e.target.value)} style={{ width: 240 }} />
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <span className="faint" style={{ fontSize: 12 }}>Group by</span>
          <select value={groupBy1} onChange={(e) => { setGroupBy1(e.target.value as MaterialGroupBy); setCollapsed({}); }}>
            {groupByOptions()}
          </select>
        </label>
        {groupBy1 !== 'none' && (
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <span className="faint" style={{ fontSize: 12 }}>Then by</span>
            <select value={effectiveGroupBy2} onChange={(e) => { setGroupBy2(e.target.value as MaterialGroupBy); setCollapsed({}); }}>
              {groupByOptions(groupBy1)}
            </select>
          </label>
        )}
        {groups && (
          <>
            <button className="btn sm" onClick={expandAll}>Expand all</button>
            <button className="btn sm" onClick={collapseAll}>Collapse all</button>
          </>
        )}
        <span className="faint" style={{ fontSize: 11, alignSelf: 'center' }}>
          {sorted.length.toLocaleString()} of {combos.length.toLocaleString()} materials
          {groups && ` across ${groups.length} group${groups.length === 1 ? '' : 's'}`}
          {' · '}
          <span style={{ color: 'var(--warning)' }}>
            {unallocated.length.toLocaleString()} unallocated ({pct(unallocatedAmount)}% of total spend)
          </span>
        </span>
      </div>
      <div className="sel-bar" ref={selBarRef}>
        {selected.size > 0 ? (
          <>
            <strong style={{ fontSize: 12 }}>{selected.size} selected</strong>
            <PackagePicker types={types} value="" clearLabel="selection"
              onChange={(v) => {
                if (!v) return;
                const rows = sorted.filter((r) => selected.has(r.material_code));
                onAllocate(rows, v);
                setSelected(new Set());
              }} />
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
          </>
        ) : (
          <span className="faint" style={{ fontSize: 12 }}>
            Select rows to assign a package to several at once.
          </span>
        )}
      </div>
      <table style={{ '--sel-bar-h': `${selBarHeight}px` } as React.CSSProperties}>
        <thead className="pkg-sticky-thead">
          <tr>
            <th style={{ width: 28, textAlign: 'center' }}>
              <TriCheckbox state={selectionState(sorted)} onChange={(checked) => setRowsSelected(sorted, checked)}
                           title="Select all visible rows" />
            </th>
            {headerCell('Code', 'material_code')}
            {headerCell('Description', 'material_name')}
            {headerCell('Prefix', 'prefix', { width: 70 })}
            {headerCell('Postings', 'postings', { textAlign: 'right', width: 90 })}
            {headerCell('Amount', 'amount', { textAlign: 'right', width: 120 })}
            <th style={{ width: 150 }}>Now</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={7}><div className="empty">No materials match.</div></td></tr>
          )}
          {groups ? groups.map((g) => {
            const open = isOpen(g.key);
            const subGroups = effectiveGroupBy2 === 'none' ? null : buildMaterialGroups(g.rows, effectiveGroupBy2, types, sort);
            return (
              <Fragment key={g.key}>
                {renderGroupHeader(g, groupBy1 as MaterialGroupKind, g.key, 0)}
                {open && (subGroups
                  ? subGroups.map((sg) => {
                      const subKey = `${g.key}::${sg.key}`;
                      const subOpen = isOpen(subKey);
                      return (
                        <Fragment key={subKey}>
                          {renderGroupHeader(sg, effectiveGroupBy2 as MaterialGroupKind, subKey, 1)}
                          {subOpen && sg.rows.map((c) => renderRow(c, 2))}
                        </Fragment>
                      );
                    })
                  : g.rows.map((c) => renderRow(c, 1)))}
              </Fragment>
            );
          }) : sorted.map((c) => renderRow(c, 0))}
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
    const keys = rows.map((r) => r.material_code);
    setSavingMaterial((s) => new Set([...s, ...keys]));
    setError(null);
    (async () => {
      try {
        const items: MaterialPackageAssignment[] = rows.map((r) => ({ material_code: r.material_code, work_package: value }));
        await call(api.workPackages.assignMaterial(items));
        await loadMaterials();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSavingMaterial((s) => { const n = new Set(s); keys.forEach((k) => n.delete(k)); return n; });
      }
    })();
  };

  const exportMaterials = () => guard(async () => {
    const path = await call(api.workPackages.exportMaterialMapping());
    setNote(path ? `Exported to ${path} — fill the "work package" column and import it back to bulk-apply.` : 'Export cancelled.');
  });

  const importMaterials = () => guard(async () => {
    const path = await call(api.files.pick('Select the edited material mapping workbook'));
    if (!path) { setNote('Import cancelled.'); return; }
    const result: MaterialImportResult = await call(api.workPackages.importMaterialMapping(path));
    await loadMaterials();
    const errText = result.errors.length
      ? ` — ${result.errors.length} unknown package code${result.errors.length === 1 ? '' : 's'}: ${
          result.errors.slice(0, 5).map((e) => `${e.material_code} → "${e.work_package}"`).join(', ')
        }${result.errors.length > 5 ? ', …' : ''}`
      : '';
    setNote(`Applied ${result.assigned}, skipped ${result.skipped}${errText}`);
  });

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
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <h3>Code materials into packages</h3>
                  <p className="hint">
                    Every real material — the SAP material number (MATNR), not the GL account, since
                    several different materials commonly share one GL — that occurs in posted MATERIAL
                    cost. {materials.length} of them. Group by code prefix to bulk-code a whole category
                    in one click, or pick a single row. Export to Excel, fill the "work package" column
                    at scale, and import it back — a line with no material code (an older extract, or the
                    column left blank) can't be coded until it has one, so it never shows up here.
                  </p>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn sm" onClick={exportMaterials} disabled={busy}>⤓ Export to Excel</button>
                  <button className="btn sm" onClick={importMaterials} disabled={busy}>⤒ Import mapping…</button>
                </div>
              </div>
              <MaterialCodingTable combos={materials} types={types} savingKeys={savingMaterial} onAllocate={allocateMaterial} />
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
                codeLabel="Service code" renderCode={(c) => c.service_code || '(no code)'}
                descLabel="Description" renderDescription={(c) => c.service_text || <span className="faint">—</span>}
                groupKey={(c) => (c.service_code || '').slice(0, 3) || '(no code)'}
                groupKeyLabel="Service code prefix (first 3 chars)"
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
                codeLabel="GL" renderCode={glLabel}
                descLabel="Cost type" renderDescription={(c) => c.cost_type ?? ''}
                unitNoun="cost element" />
            </div>
          ),
        },
      ]} />
    </>
  );
}
