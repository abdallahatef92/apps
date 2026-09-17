import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { money, pct } from '../lib/format';
import type { CostTypeDef, QueryResult } from '@shared/types';

type Tab = 'month' | 'txn' | 'anomaly';
type Source = 'ACTUAL' | 'BUDGET' | 'FORECAST';

const SOURCE_QUERY: Record<Source, string> = {
  ACTUAL: 'COST_BY_TYPE_GL_MONTH', BUDGET: 'BUDGET_BY_TYPE_GL_MONTH', FORECAST: 'FORECAST_BY_TYPE_GL_MONTH',
};
const SOURCE_LABEL: Record<Source, string> = { ACTUAL: 'Actual', BUDGET: 'Budget', FORECAST: 'Forecast' };

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A budget that is not time-phased carries no period_key at all — v_budget allows it. */
const NO_PERIOD = '(no period)';
const periodLabel = (key: string) => {
  if (!key || key === NO_PERIOD) return NO_PERIOD;
  const [y, m] = key.split('-');
  return `${MONTH_ABBR[Number(m) - 1] ?? m} ${y.slice(2)}`;
};

interface MonthRow {
  cost_type: string; cost_element_code: string; cost_element_name: string | null;
  wbs_code: string | null; wbs_name: string | null;
  period_key: string; postings: number; amount: number;
}

const NO_WBS = '(no WBS)';

interface WbsNode {
  code: string; name: string | null; postings: number; amount: number;
  byPeriod: Map<string, number>;
}
interface GlNode {
  code: string; name: string | null; postings: number; amount: number;
  byPeriod: Map<string, number>; wbs: WbsNode[];
}
interface TypeNode {
  type: string; postings: number; amount: number;
  gls: GlNode[]; byPeriod: Map<string, number>;
}

/**
 * Long format (one row per cost type / GL / WBS / month, from SQL) turned
 * into a three-level tree with periods folded into columns — a display
 * transform, not aggregation: every number in it is still a straight sum
 * from the query. A GL's own totals are the sum of its WBS breakdown, so
 * collapsing the WBS level away changes nothing about what a GL row shows.
 */
function buildTree(rows: MonthRow[]): { periods: string[]; types: TypeNode[]; grandTotal: number; grandPostings: number } {
  const periods = [...new Set(rows.map((r) => r.period_key || NO_PERIOD))].sort();
  const byType = new Map<string, Map<string, { name: string | null; wbs: Map<string, WbsNode> }>>();
  for (const r of rows) {
    const pk = r.period_key || NO_PERIOD;
    const wbsCode = r.wbs_code || NO_WBS;
    let gls = byType.get(r.cost_type);
    if (!gls) { gls = new Map(); byType.set(r.cost_type, gls); }
    let glEntry = gls.get(r.cost_element_code);
    if (!glEntry) { glEntry = { name: r.cost_element_name, wbs: new Map() }; gls.set(r.cost_element_code, glEntry); }
    let wbs = glEntry.wbs.get(wbsCode);
    if (!wbs) { wbs = { code: wbsCode, name: r.wbs_name, postings: 0, amount: 0, byPeriod: new Map() }; glEntry.wbs.set(wbsCode, wbs); }
    wbs.postings += r.postings;
    wbs.amount += r.amount;
    wbs.byPeriod.set(pk, (wbs.byPeriod.get(pk) ?? 0) + r.amount);
  }
  let grandTotal = 0, grandPostings = 0;
  const types: TypeNode[] = [...byType.entries()].map(([type, gls]) => {
    const glList: GlNode[] = [...gls.entries()].map(([code, entry]) => {
      const wbsList = [...entry.wbs.values()];
      const byPeriod = new Map<string, number>();
      let postings = 0, amount = 0;
      for (const w of wbsList) {
        postings += w.postings;
        amount += w.amount;
        for (const [pk, amt] of w.byPeriod) byPeriod.set(pk, (byPeriod.get(pk) ?? 0) + amt);
      }
      return { code, name: entry.name, postings, amount, byPeriod, wbs: wbsList };
    });
    const byPeriod = new Map<string, number>();
    let postings = 0, amount = 0;
    for (const gl of glList) {
      postings += gl.postings;
      amount += gl.amount;
      for (const [pk, amt] of gl.byPeriod) byPeriod.set(pk, (byPeriod.get(pk) ?? 0) + amt);
    }
    grandTotal += amount;
    grandPostings += postings;
    return { type, postings, amount, gls: glList, byPeriod };
  });
  return { periods, types, grandTotal, grandPostings };
}

/** Sort key shared by both the group and GL rows: a period, or one of the fixed columns. */
type SortKey = 'txn' | 'total' | string;

function sortValue(n: { postings: number; amount: number; byPeriod: Map<string, number> }, key: SortKey | null): number {
  if (!key || key === 'total') return Math.abs(n.amount);
  if (key === 'txn') return n.postings;
  return Math.abs(n.byPeriod.get(key) ?? 0);
}

function sortNodes<T extends { postings: number; amount: number; byPeriod: Map<string, number> }>(
  nodes: T[], key: SortKey | null, dir: 'asc' | 'desc',
): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...nodes].sort((a, b) => (sortValue(a, key) - sortValue(b, key)) * sign);
}

const LABEL_W = 240, CODE_W = 90, TXN_W = 64, SHARE_W = 140, MONTH_W = 96, TOTAL_W = 100;

/** A small horizontal share-of-total bar, coloured by the row's cost type. */
function ShareBar({ pctValue, color }: { pctValue: number; color: string }) {
  const w = Math.max(2, Math.min(100, Math.abs(pctValue)));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 50, height: 5, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
        <div style={{ width: `${w}%`, height: '100%', background: color }} />
      </div>
      <span className="mono" style={{ fontSize: 11 }}>{pct(pctValue)}</span>
    </div>
  );
}

function typeMeta(types: CostTypeDef[], code: string) {
  return types.find((t) => t.code === code)
    ?? { code, label: code === 'UNMAPPED' ? 'Unmapped' : code, icon: '❓', color: '#9aa5b1', sort_order: 999, is_system: 0 };
}

interface Filters { search: string; types: Set<string>; periodFrom: string; periodTo: string }
const EMPTY_FILTERS: Filters = { search: '', types: new Set(), periodFrom: '', periodTo: '' };

/**
 * Shared by the on-screen tree and the Excel export, so "what you filtered to
 * is what you get in the file" — operates on raw query rows (cost_type,
 * cost_element_code/name and period_key are common to both the monthly and
 * the transaction-level result sets). An empty `types` set means "no filter".
 */
function filterRows(rows: Record<string, unknown>[], f: Filters): Record<string, unknown>[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.types.size > 0 && !f.types.has(String(r.cost_type ?? ''))) return false;
    const pk = String(r.period_key ?? '');
    if (f.periodFrom && pk < f.periodFrom) return false;
    if (f.periodTo && pk > f.periodTo) return false;
    if (q && !`${r.cost_element_code ?? ''} ${r.cost_element_name ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/**
 * One filter bar shared by both tabs: free-text search over the GL code and
 * description, a cost-type pill toggle (reusing the same icons as the
 * picker in Settings), and a period range. Filtering happens client-side —
 * the whole month's worth of rows is already in memory — so results update
 * as you type or click, with no round trip.
 */
function FilterBar({ filters, onChange, types, periods, matched, total }: {
  filters: Filters; onChange: (f: Filters) => void; types: CostTypeDef[]; periods: string[];
  matched: number; total: number;
}) {
  const present = [...types.map((t) => t.code), 'UNMAPPED'].filter((c, i, a) => a.indexOf(c) === i);
  const toggleType = (code: string) => {
    const next = new Set(filters.types);
    if (next.has(code)) next.delete(code); else next.add(code);
    onChange({ ...filters, types: next });
  };
  const active = filters.search || filters.types.size > 0 || filters.periodFrom || filters.periodTo;

  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 14, alignItems: 'center' }}>
      <input placeholder="Search GL code or name…" value={filters.search} style={{ width: 220 }}
             onChange={(e) => onChange({ ...filters, search: e.target.value })} />
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {present.map((code) => {
          const meta = typeMeta(types, code);
          const on = filters.types.has(code);
          return (
            <button key={code} type="button" title={meta.label} onClick={() => toggleType(code)}
                    style={{
                      fontSize: 12, padding: '4px 9px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
                      background: on ? meta.color : 'var(--surface-3)', color: on ? '#0b0f14' : 'var(--text-2)',
                      border: `1px solid ${on ? meta.color : 'var(--border)'}`, fontWeight: on ? 700 : 400,
                    }}>
              {meta.icon} {meta.label}
            </button>
          );
        })}
      </div>
      <label className="field" style={{ margin: 0 }}>
        <select value={filters.periodFrom} onChange={(e) => onChange({ ...filters, periodFrom: e.target.value })}>
          <option value="">From…</option>
          {periods.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
        </select>
      </label>
      <label className="field" style={{ margin: 0 }}>
        <select value={filters.periodTo} onChange={(e) => onChange({ ...filters, periodTo: e.target.value })}>
          <option value="">To…</option>
          {periods.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
        </select>
      </label>
      {active && (
        <button className="btn sm ghost" onClick={() => onChange(EMPTY_FILTERS)}>Clear filters</button>
      )}
      {active && (
        <span className="faint" style={{ fontSize: 11 }}>{matched.toLocaleString()} of {total.toLocaleString()} rows match</span>
      )}
    </div>
  );
}

/**
 * A sticky cell needs a fully opaque background — it visually sits on top of
 * whatever has scrolled underneath it, and a translucent tint (color + alpha)
 * lets that scrolled content bleed through as a ghosting artefact. color-mix
 * pre-blends the tint against the real surface colour into one opaque value.
 */
const rowTint = (color: string) => `color-mix(in srgb, ${color} 12%, var(--surface))`;

function SortableTh({ label, active, dir, onClick, style }: {
  label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; style?: CSSProperties;
}) {
  return (
    <th onClick={onClick} style={{ cursor: 'pointer', userSelect: 'none', ...style }} title="Click to sort">
      {label}{active && <span className="faint" style={{ marginLeft: 4 }}>{dir === 'desc' ? '▾' : '▴'}</span>}
    </th>
  );
}

/**
 * Cost type → GL, sorted by spend, months as columns. Same shape as the
 * Settings allocation table's grouping, but the leaf here is a month's worth
 * of postings rather than an icon picker. A totals row and a totals column
 * close the pivot off on both axes, and any column header can be clicked to
 * re-sort both the groups and the GLs within them by that column.
 */
function MonthlyPivot({ rows, types }: { rows: MonthRow[]; types: CostTypeDef[] }) {
  const { periods, types: tree, grandTotal, grandPostings } = useMemo(() => buildTree(rows), [rows]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [openGl, setOpenGl] = useState<Record<string, boolean>>({});
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const isOpen = (t: string) => !collapsed[t];
  const toggle = (t: string) => setCollapsed((c) => ({ ...c, [t]: isOpen(t) }));
  const toggleGl = (code: string) => setOpenGl((c) => ({ ...c, [code]: !c[code] }));

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const sortedTree = useMemo(
    () => sortNodes(tree, sortKey, sortDir).map((g) => ({
      ...g,
      gls: sortNodes(g.gls, sortKey, sortDir).map((gl) => ({ ...gl, wbs: sortNodes(gl.wbs, sortKey, sortDir) })),
    })),
    [tree, sortKey, sortDir],
  );

  const periodTotal = (p: string) => tree.reduce((s, g) => s + (g.byPeriod.get(p) ?? 0), 0);
  const thBase = { position: 'sticky' as const, top: 0, background: 'var(--surface-2)', zIndex: 3 };

  return (
    <div className="table-wrap" style={{ overflowX: 'auto' }}>
      <table style={{ tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0 }}>
        <colgroup>
          <col style={{ width: LABEL_W }} />
          <col style={{ width: CODE_W }} />
          <col style={{ width: TXN_W }} />
          <col style={{ width: SHARE_W }} />
          {periods.map((p) => <col key={p} style={{ width: MONTH_W }} />)}
          <col style={{ width: TOTAL_W }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...thBase, position: 'sticky', left: 0, zIndex: 4 }}>Category / cost element</th>
            <th style={{ ...thBase, position: 'sticky', left: LABEL_W, zIndex: 4 }}>G/L account</th>
            <SortableTh label="Txn" active={sortKey === 'txn'} dir={sortDir} onClick={() => sortBy('txn')}
              style={{ ...thBase, position: 'sticky', left: LABEL_W + CODE_W, zIndex: 4, textAlign: 'right' }} />
            <SortableTh label="Share" active={sortKey === null || sortKey === 'total'} dir={sortDir} onClick={() => sortBy('total')}
              style={{ ...thBase, position: 'sticky', left: LABEL_W + CODE_W + TXN_W, zIndex: 4 }} />
            {periods.map((p) => (
              <SortableTh key={p} label={periodLabel(p)} active={sortKey === p} dir={sortDir} onClick={() => sortBy(p)}
                style={{ ...thBase, textAlign: 'right' }} />
            ))}
            <th style={{ ...thBase, textAlign: 'right' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {tree.length === 0 && (
            <tr><td colSpan={5 + periods.length}><div className="empty">No actual cost loaded yet.</div></td></tr>
          )}
          {sortedTree.map((g) => {
            const meta = typeMeta(types, g.type);
            const open = isOpen(g.type);
            const tint = rowTint(meta.color);
            return (
              <Fragment key={g.type}>
                <tr style={{ background: tint, cursor: 'pointer' }} onClick={() => toggle(g.type)}>
                  <td style={{ position: 'sticky', left: 0, zIndex: 1, background: tint, fontWeight: 700 }}>
                    <span className="faint" style={{ marginRight: 6 }}>{open ? '▾' : '▸'}</span>
                    <span style={{ marginRight: 6 }}>{meta.icon}</span>
                    <span style={{ color: meta.color }}>{meta.label}</span>
                  </td>
                  <td style={{ position: 'sticky', left: LABEL_W, zIndex: 1, background: tint }}></td>
                  <td className="mono" style={{ position: 'sticky', left: LABEL_W + CODE_W, zIndex: 1, background: tint, textAlign: 'right' }}>
                    {g.postings.toLocaleString()}
                  </td>
                  <td style={{ position: 'sticky', left: LABEL_W + CODE_W + TXN_W, zIndex: 1, background: tint }}>
                    <ShareBar pctValue={grandTotal ? (g.amount / grandTotal) * 100 : 0} color={meta.color} />
                  </td>
                  {periods.map((p) => (
                    <td key={p} className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                      {g.byPeriod.has(p) ? money(g.byPeriod.get(p)) : '–'}
                    </td>
                  ))}
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(g.amount)}</td>
                </tr>
                {open && g.gls.map((gl) => {
                  const glOpen = !!openGl[gl.code];
                  const showWbs = gl.wbs.length > 1 || gl.wbs[0]?.code !== NO_WBS;
                  return (
                    <Fragment key={gl.code}>
                      <tr style={showWbs ? { cursor: 'pointer' } : undefined} onClick={showWbs ? () => toggleGl(gl.code) : undefined}>
                        <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', paddingLeft: 26 }}
                            title={gl.name ?? gl.code}>
                          {showWbs && <span className="faint" style={{ marginRight: 6 }}>{glOpen ? '▾' : '▸'}</span>}
                          {gl.name ?? gl.code}
                        </td>
                        <td style={{ position: 'sticky', left: LABEL_W, zIndex: 1, background: 'var(--surface)' }}>
                          <span className="badge mute plain mono" style={{ fontSize: 10 }}>{gl.code}</span>
                        </td>
                        <td className="mono faint" style={{ position: 'sticky', left: LABEL_W + CODE_W, zIndex: 1, background: 'var(--surface)', textAlign: 'right' }}>
                          {gl.postings.toLocaleString()}
                        </td>
                        <td style={{ position: 'sticky', left: LABEL_W + CODE_W + TXN_W, zIndex: 1, background: 'var(--surface)' }}>
                          <ShareBar pctValue={grandTotal ? (gl.amount / grandTotal) * 100 : 0} color={meta.color} />
                        </td>
                        {periods.map((p) => (
                          <td key={p} className="mono faint" style={{ textAlign: 'right' }}>
                            {gl.byPeriod.has(p) ? money(gl.byPeriod.get(p)) : '–'}
                          </td>
                        ))}
                        <td className="mono faint" style={{ textAlign: 'right' }}>{money(gl.amount)}</td>
                      </tr>
                      {glOpen && gl.wbs.map((w) => (
                        <tr key={w.code}>
                          <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', paddingLeft: 46 }}
                              className="faint" title={w.code === NO_WBS ? undefined : w.code}>
                            {w.code === NO_WBS ? w.code : (w.name ? `${w.name} (${w.code})` : w.code)}
                          </td>
                          <td style={{ position: 'sticky', left: LABEL_W, zIndex: 1, background: 'var(--surface)' }}></td>
                          <td className="mono faint" style={{ position: 'sticky', left: LABEL_W + CODE_W, zIndex: 1, background: 'var(--surface)', textAlign: 'right' }}>
                            {w.postings.toLocaleString()}
                          </td>
                          <td style={{ position: 'sticky', left: LABEL_W + CODE_W + TXN_W, zIndex: 1, background: 'var(--surface)' }}>
                            <ShareBar pctValue={grandTotal ? (w.amount / grandTotal) * 100 : 0} color={meta.color} />
                          </td>
                          {periods.map((p) => (
                            <td key={p} className="mono faint" style={{ textAlign: 'right' }}>
                              {w.byPeriod.has(p) ? money(w.byPeriod.get(p)) : '–'}
                            </td>
                          ))}
                          <td className="mono faint" style={{ textAlign: 'right' }}>{money(w.amount)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </Fragment>
            );
          })}
          {tree.length > 0 && (
            <tr style={{ borderTop: '2px solid var(--border)' }}>
              <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface-2)', fontWeight: 700 }}>Total</td>
              <td style={{ position: 'sticky', left: LABEL_W, zIndex: 1, background: 'var(--surface-2)' }}></td>
              <td className="mono" style={{ position: 'sticky', left: LABEL_W + CODE_W, zIndex: 1, background: 'var(--surface-2)', textAlign: 'right', fontWeight: 700 }}>
                {grandPostings.toLocaleString()}
              </td>
              <td style={{ position: 'sticky', left: LABEL_W + CODE_W + TXN_W, zIndex: 1, background: 'var(--surface-2)', fontWeight: 700 }}>100.0%</td>
              {periods.map((p) => (
                <td key={p} className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(periodTotal(p))}</td>
              ))}
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(grandTotal)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Same tree, one level deeper: a GL's transactions are fetched only once it
 * is expanded, so opening the page never pulls every posting up front. Closed
 * off the same way as the monthly pivot, with a totals row at the bottom.
 */
/** A GL's transactions, grouped by the period they posted in — oldest first. */
function groupByPeriod(rows: Record<string, unknown>[]): { period: string; rows: Record<string, unknown>[]; postings: number; amount: number }[] {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const p = String(r.period_key ?? '');
    map.set(p, [...(map.get(p) ?? []), r]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, prows]) => ({
      period, rows: prows, postings: prows.length,
      amount: prows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    }));
}

function TransactionTree({ rows, types, filters }: { rows: MonthRow[]; types: CostTypeDef[]; filters: Filters }) {
  const { types: tree, grandTotal, grandPostings } = useMemo(() => buildTree(rows), [rows]);
  const [collapsedType, setCollapsedType] = useState<Record<string, boolean>>({});
  const [openGl, setOpenGl] = useState<Record<string, boolean>>({});
  const [collapsedPeriod, setCollapsedPeriod] = useState<Record<string, boolean>>({});
  const [txns, setTxns] = useState<Record<string, QueryResult>>({});
  const [loadingGl, setLoadingGl] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<'txn' | 'total' | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const { projectKey } = useApp();

  const sortBy = (key: 'txn' | 'total') => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir('desc'); }
  };
  const sortedTree = useMemo(
    () => sortNodes(tree, sortKey, sortDir).map((g) => ({ ...g, gls: sortNodes(g.gls, sortKey, sortDir) })),
    [tree, sortKey, sortDir],
  );

  const toggleType = (t: string) => setCollapsedType((c) => ({ ...c, [t]: !c[t] }));
  const togglePeriod = (key: string) => setCollapsedPeriod((c) => ({ ...c, [key]: !c[key] }));
  const toggleGl = async (code: string) => {
    const willOpen = !openGl[code];
    setOpenGl((s) => ({ ...s, [code]: willOpen }));
    if (willOpen && !txns[code] && projectKey) {
      setLoadingGl(code);
      try {
        const res = await call(api.queries.run('COST_BY_TYPE_GL_TXN', { project_key: projectKey, cost_element_code: code }));
        setTxns((s) => ({ ...s, [code]: res }));
      } finally { setLoadingGl(null); }
    }
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 24 }}></th>
            <th>Category / cost element / posting</th>
            <th>WBS</th>
            <th>Doc type</th>
            <th>Period</th>
            <th>Vendor</th>
            <SortableTh label="Txn" active={sortKey === 'txn'} dir={sortDir} onClick={() => sortBy('txn')} style={{ textAlign: 'right' }} />
            <SortableTh label="Amount" active={sortKey === null || sortKey === 'total'} dir={sortDir} onClick={() => sortBy('total')} style={{ textAlign: 'right' }} />
            <th style={{ width: 140 }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {tree.length === 0 && (
            <tr><td colSpan={9}><div className="empty">No actual cost loaded yet.</div></td></tr>
          )}
          {sortedTree.map((g) => {
            const meta = typeMeta(types, g.type);
            const open = !collapsedType[g.type];
            return (
              <Fragment key={g.type}>
                <tr style={{ background: rowTint(meta.color), cursor: 'pointer' }} onClick={() => toggleType(g.type)}>
                  <td className="faint" style={{ textAlign: 'center' }}>{open ? '▾' : '▸'}</td>
                  <td colSpan={5} style={{ fontWeight: 700 }}>
                    <span style={{ marginRight: 6 }}>{meta.icon}</span>
                    <span style={{ color: meta.color }}>{meta.label}</span>
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{g.postings.toLocaleString()}</td>
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(g.amount)}</td>
                  <td><ShareBar pctValue={grandTotal ? (g.amount / grandTotal) * 100 : 0} color={meta.color} /></td>
                </tr>
                {open && g.gls.map((gl) => {
                  const glOpen = !!openGl[gl.code];
                  return (
                    <Fragment key={gl.code}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => toggleGl(gl.code)}>
                        <td className="faint" style={{ textAlign: 'center' }}>{glOpen ? '▾' : '▸'}</td>
                        <td colSpan={5} style={{ paddingLeft: 20 }} title={gl.code}>
                          {gl.name ?? gl.code} <span className="faint mono" style={{ fontSize: 10 }}>{gl.code}</span>
                        </td>
                        <td className="mono faint" style={{ textAlign: 'right' }}>{gl.postings.toLocaleString()}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{money(gl.amount)}</td>
                        <td><ShareBar pctValue={grandTotal ? (gl.amount / grandTotal) * 100 : 0} color={meta.color} /></td>
                      </tr>
                      {glOpen && loadingGl === gl.code && (
                        <tr><td></td><td colSpan={8}><div className="empty">Loading…</div></td></tr>
                      )}
                      {glOpen && txns[gl.code] && groupByPeriod(filterRows(txns[gl.code].rows, filters)).map((pg) => {
                        const periodKey = `${gl.code}::${pg.period}`;
                        const periodOpen = !collapsedPeriod[periodKey];
                        return (
                          <Fragment key={periodKey}>
                            <tr style={{ cursor: 'pointer', background: 'var(--surface-2)' }} onClick={() => togglePeriod(periodKey)}>
                              <td className="faint" style={{ textAlign: 'center' }}>{periodOpen ? '▾' : '▸'}</td>
                              <td colSpan={4} style={{ paddingLeft: 40 }} className="mono faint">
                                {periodLabel(pg.period) || pg.period || '(no period)'}
                              </td>
                              <td></td>
                              <td className="mono faint" style={{ textAlign: 'right' }}>{pg.postings.toLocaleString()}</td>
                              <td className="mono faint" style={{ textAlign: 'right' }}>
                                {pg.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                              </td>
                              <td></td>
                            </tr>
                            {periodOpen && pg.rows.map((r: any, i: number) => (
                              <tr key={i}>
                                <td></td>
                                <td style={{ paddingLeft: 60 }} className="mono faint" title={r.description ?? ''}>
                                  {r.source && r.source !== 'ACTUAL' && (
                                    <span className="badge mute plain" style={{ fontSize: 9, marginRight: 6 }}>{r.source}</span>
                                  )}
                                  {r.document_no}{r.description ? ` — ${r.description}` : ''}
                                </td>
                                <td className="mono faint" title={r.wbs_name ?? ''}>{r.wbs_code || '—'}</td>
                                <td className="mono faint">{r.document_type || '(none)'}</td>
                                <td className="mono faint">{r.period_key}</td>
                                <td className="faint">{r.vendor_name ?? '—'}</td>
                                <td></td>
                                <td className="mono" style={{ textAlign: 'right' }}>
                                  {Number(r.amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                </td>
                                <td></td>
                              </tr>
                            ))}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </Fragment>
            );
          })}
          {tree.length > 0 && (
            <tr style={{ borderTop: '2px solid var(--border)' }}>
              <td></td>
              <td colSpan={5} style={{ fontWeight: 700 }}>Total</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{grandPostings.toLocaleString()}</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(grandTotal)}</td>
              <td style={{ fontWeight: 700 }}>100.0%</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Each anomaly reason is its own chip so several flags on one posting stay legible. */
function ReasonChips({ reasons }: { reasons: string }) {
  const list = reasons.split(';').map((r) => r.trim()).filter(Boolean);
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {list.map((r, i) => (
        <span key={i} className="badge warn plain" style={{ fontSize: 10, whiteSpace: 'normal' }}>{r}</span>
      ))}
    </div>
  );
}

/**
 * A flat list, not a tree — every row already carries its own "why flagged"
 * reasons, so grouping by cost type would only get in the way of scanning
 * them. Every check is a plain SQL predicate in ANOMALY_TRANSACTIONS, listed
 * in the hint below so a reviewer knows exactly what "flagged" means here.
 */
function AnomalyTable({ rows, types, sortDir, sortKey, onSort }: {
  rows: Record<string, unknown>[]; types: CostTypeDef[];
  sortKey: 'amount' | null; sortDir: 'asc' | 'desc'; onSort: () => void;
}) {
  const sorted = useMemo(() => {
    const sign = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => (Math.abs(Number(a.amount ?? 0)) - Math.abs(Number(b.amount ?? 0))) * sign);
  }, [rows, sortDir]);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>WBS</th>
            <th>Cost type</th>
            <th>GL account</th>
            <th>Document</th>
            <th>Period</th>
            <th>Vendor</th>
            <SortableTh label="Amount" active={sortKey === 'amount'} dir={sortDir} onClick={onSort} style={{ textAlign: 'right' }} />
            <th>Why flagged</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={8}><div className="empty">Nothing flagged — every posting passes the checks below.</div></td></tr>
          )}
          {sorted.map((r: any, i: number) => (
            <tr key={i}>
              <td className="mono faint" title={r.wbs_name ?? ''}>{r.wbs_code || '—'}</td>
              <td><CostBadge types={types} code={String(r.cost_type ?? 'UNMAPPED')} /></td>
              <td title={r.cost_element_name ?? ''}>
                {r.cost_element_name ?? r.cost_element_code}
                <span className="faint mono" style={{ fontSize: 10, marginLeft: 6 }}>{r.cost_element_code}</span>
              </td>
              <td className="mono faint" title={r.description ?? ''}>
                {r.document_no}{r.document_type ? ` (${r.document_type})` : ''}
              </td>
              <td className="mono faint">{r.period_key}</td>
              <td className="faint">{r.vendor_name ?? '—'}</td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {Number(r.amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </td>
              <td><ReasonChips reasons={String(r.reasons ?? '')} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CostBadge({ types, code }: { types: CostTypeDef[]; code: string }) {
  const meta = typeMeta(types, code);
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

const ANOMALY_CHECKS = [
  'Cost type not classified', 'No WBS element', 'Negative amount',
  'Unusually large for its GL (over 5x the GL\'s average)', 'Subcontract cost with no vendor named',
  'PO or settled order posted with no detail loaded yet', 'Possible duplicate (same WBS/GL/vendor/amount/period)',
];

export function Reports() {
  const { projectKey, project, dataVersion } = useApp();
  const [source, setSource] = useState<Source>('ACTUAL');
  const [tab, setTab] = useState<Tab>('month');
  const [types, setTypes] = useState<CostTypeDef[]>([]);
  const [monthly, setMonthly] = useState<QueryResult | null>(null);
  const [anomalies, setAnomalies] = useState<QueryResult | null>(null);
  const [anomalySortDir, setAnomalySortDir] = useState<'asc' | 'desc'>('desc');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  /** Budget and forecast have no posting-level grain, so Transactions/Anomalies are actual-only. */
  const setSourceAndTab = (s: Source) => { setSource(s); if (s !== 'ACTUAL') setTab('month'); };

  useEffect(() => {
    api.costTypes.types().then((r) => { if (r.ok) setTypes(r.data); });
  }, []);

  useEffect(() => {
    if (!projectKey) { setMonthly(null); return; }
    setBusy(true); setError(null);
    call(api.queries.run(SOURCE_QUERY[source], { project_key: projectKey }))
      .then(setMonthly)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [projectKey, dataVersion, source]);

  /** Fetched only once the tab is actually opened — a project's full posting history, scored. */
  useEffect(() => {
    if (tab !== 'anomaly' || !projectKey) return;
    setBusy(true); setError(null);
    call(api.queries.run('ANOMALY_TRANSACTIONS', { project_key: projectKey }))
      .then(setAnomalies)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [tab, projectKey, dataVersion]);

  const rows = (monthly?.rows ?? []) as unknown as MonthRow[];
  const periods = useMemo(() => [...new Set(rows.map((r) => r.period_key).filter(Boolean))].sort(), [rows]);
  const filteredRows = useMemo(() => filterRows(monthly?.rows ?? [], filters) as unknown as MonthRow[], [monthly, filters]);
  const anomalyRows = useMemo(() => filterRows(anomalies?.rows ?? [], filters), [anomalies, filters]);

  const activeCount = tab === 'anomaly' ? anomalyRows.length : filteredRows.length;
  const activeTotal = tab === 'anomaly' ? (anomalies?.rows.length ?? 0) : rows.length;

  /** Exports whichever tab and source are actually on screen, filtered the same way they're shown. */
  const exportXlsx = async () => {
    setBusy(true); setError(null); setSavedTo(null);
    try {
      if (tab === 'month') {
        if (!monthly) return;
        const filtered = filterRows(monthly.rows, filters);
        setSavedTo(await call(api.exportResult({ ...monthly, rows: filtered, rowCount: filtered.length }, {
          title: `${SOURCE_LABEL[source]} by cost type, GL and month`,
          subtitle: 'One row per cost type / GL / WBS / month — pivot and group in Excel as needed.',
          context: { Project: project?.project_code, Source: SOURCE_LABEL[source] },
        })));
      } else if (tab === 'txn') {
        if (!projectKey) return;
        const all = await call(api.queries.run('COST_BY_TYPE_GL_TXN', { project_key: projectKey, cost_element_code: null }));
        const filtered = filterRows(all.rows, filters);
        setSavedTo(await call(api.exportResult({ ...all, rows: filtered, rowCount: filtered.length }, {
          title: 'Actual postings by cost type and GL',
          subtitle: 'Every individual posting behind Reports → Transactions, one row each — PO and '
            + 'settled-order detail substituted in where loaded.',
          context: { Project: project?.project_code },
        })));
      } else {
        if (!anomalies) return;
        const filtered = filterRows(anomalies.rows, filters);
        setSavedTo(await call(api.exportResult({ ...anomalies, rows: filtered, rowCount: filtered.length }, {
          title: 'Anomaly transactions',
          subtitle: 'Actual postings that failed at least one data-quality check — see the "reasons" column.',
          context: { Project: project?.project_code, Checks: ANOMALY_CHECKS.join(' | ') },
        })));
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      {error && <div className="banner err">{error}</div>}
      {savedTo && (
        <div className="banner ok">
          Exported to <span className="mono">{savedTo}</span>
          <button className="btn sm ghost" style={{ marginLeft: 10 }} onClick={() => api.showItem(savedTo)}>Show in folder</button>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div className="row" style={{ gap: 10 }}>
            <div className="segmented">
              {(['ACTUAL', 'BUDGET', 'FORECAST'] as Source[]).map((s) => (
                <button key={s} className={source === s ? 'on' : ''} onClick={() => setSourceAndTab(s)}>{SOURCE_LABEL[s]}</button>
              ))}
            </div>
            <div className="segmented">
              <button className={tab === 'month' ? 'on' : ''} onClick={() => setTab('month')}>By month</button>
              <button className={tab === 'txn' ? 'on' : ''} onClick={() => setTab('txn')} disabled={source !== 'ACTUAL'}
                      title={source !== 'ACTUAL' ? 'Only actual cost has individual postings' : undefined}>
                Transactions
              </button>
              <button className={tab === 'anomaly' ? 'on' : ''} onClick={() => setTab('anomaly')} disabled={source !== 'ACTUAL'}
                      title={source !== 'ACTUAL' ? 'Only actual cost is checked for anomalies' : undefined}>
                Anomalies
              </button>
            </div>
          </div>
          <button className="btn" onClick={exportXlsx} disabled={busy || !activeCount}>⤓ Excel</button>
        </div>

        <p className="hint">
          {tab === 'month'
            ? `${SOURCE_LABEL[source]} cost by cost type, GL account, WBS and month`
              + (source === 'ACTUAL' ? ' — PO and settled-order detail is substituted in where it has been loaded, so nothing is counted twice.'
                : '.')
              + ' Share is each row\'s slice of the total — click a column header to sort by it, or a GL row to see its WBS split.'
            : tab === 'txn'
            ? 'The same grouping down to individual postings, merging direct actuals with PO and order '
              + 'detail — expand a GL to load its transactions.'
            : `Postings worth a second look: ${ANOMALY_CHECKS.join(' · ')}.`}
        </p>

        <FilterBar filters={filters} onChange={setFilters} types={types} periods={periods}
                   matched={activeCount} total={activeTotal} />

        {busy && !monthly && tab !== 'anomaly' ? (
          <div className="empty">Loading…</div>
        ) : tab === 'month' ? (
          <MonthlyPivot rows={filteredRows} types={types} />
        ) : tab === 'txn' ? (
          <TransactionTree rows={filteredRows} types={types} filters={filters} />
        ) : busy && !anomalies ? (
          <div className="empty">Checking postings…</div>
        ) : (
          <AnomalyTable rows={anomalyRows} types={types} sortKey="amount" sortDir={anomalySortDir}
            onSort={() => setAnomalySortDir((d) => (d === 'desc' ? 'asc' : 'desc'))} />
        )}
      </div>
    </>
  );
}
