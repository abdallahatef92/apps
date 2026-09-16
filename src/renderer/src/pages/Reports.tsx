import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { money, pct } from '../lib/format';
import type { CostTypeDef, QueryResult } from '@shared/types';

type Tab = 'month' | 'txn';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const periodLabel = (key: string) => {
  const [y, m] = key.split('-');
  return `${MONTH_ABBR[Number(m) - 1] ?? m} ${y.slice(2)}`;
};

interface MonthRow {
  cost_type: string; cost_element_code: string; cost_element_name: string | null;
  period_key: string; postings: number; amount: number;
}

interface GlNode {
  code: string; name: string | null; postings: number; amount: number;
  byPeriod: Map<string, number>;
}
interface TypeNode {
  type: string; postings: number; amount: number;
  gls: GlNode[]; byPeriod: Map<string, number>;
}

/**
 * Long format (one row per cost type / GL / month, from SQL) turned into a
 * two-level tree with periods folded into columns — a display transform, not
 * aggregation: every number in it is still a straight sum from the query.
 */
function buildTree(rows: MonthRow[]): { periods: string[]; types: TypeNode[]; grandTotal: number; grandPostings: number } {
  const periods = [...new Set(rows.map((r) => r.period_key))].sort();
  const byType = new Map<string, Map<string, GlNode>>();
  for (const r of rows) {
    let gls = byType.get(r.cost_type);
    if (!gls) { gls = new Map(); byType.set(r.cost_type, gls); }
    let gl = gls.get(r.cost_element_code);
    if (!gl) {
      gl = { code: r.cost_element_code, name: r.cost_element_name, postings: 0, amount: 0, byPeriod: new Map() };
      gls.set(r.cost_element_code, gl);
    }
    gl.postings += r.postings;
    gl.amount += r.amount;
    gl.byPeriod.set(r.period_key, (gl.byPeriod.get(r.period_key) ?? 0) + r.amount);
  }
  let grandTotal = 0, grandPostings = 0;
  const types: TypeNode[] = [...byType.entries()].map(([type, gls]) => {
    const glList = [...gls.values()];
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
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const isOpen = (t: string) => !collapsed[t];
  const toggle = (t: string) => setCollapsed((c) => ({ ...c, [t]: isOpen(t) }));

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const sortedTree = useMemo(
    () => sortNodes(tree, sortKey, sortDir).map((g) => ({ ...g, gls: sortNodes(g.gls, sortKey, sortDir) })),
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
                {open && g.gls.map((gl) => (
                  <tr key={gl.code}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', paddingLeft: 26 }}
                        title={gl.name ?? gl.code}>
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
                ))}
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
function TransactionTree({ rows, types }: { rows: MonthRow[]; types: CostTypeDef[] }) {
  const { types: tree, grandTotal, grandPostings } = useMemo(() => buildTree(rows), [rows]);
  const [collapsedType, setCollapsedType] = useState<Record<string, boolean>>({});
  const [openGl, setOpenGl] = useState<Record<string, boolean>>({});
  const [txns, setTxns] = useState<Record<string, QueryResult>>({});
  const [loadingGl, setLoadingGl] = useState<string | null>(null);
  const { projectKey } = useApp();

  const toggleType = (t: string) => setCollapsedType((c) => ({ ...c, [t]: !c[t] }));
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
            <th>Doc type</th>
            <th>Period</th>
            <th>Vendor</th>
            <th style={{ textAlign: 'right' }}>Txn</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
            <th style={{ width: 140 }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {tree.length === 0 && (
            <tr><td colSpan={8}><div className="empty">No actual cost loaded yet.</div></td></tr>
          )}
          {tree.map((g) => {
            const meta = typeMeta(types, g.type);
            const open = !collapsedType[g.type];
            return (
              <Fragment key={g.type}>
                <tr style={{ background: rowTint(meta.color), cursor: 'pointer' }} onClick={() => toggleType(g.type)}>
                  <td className="faint" style={{ textAlign: 'center' }}>{open ? '▾' : '▸'}</td>
                  <td colSpan={4} style={{ fontWeight: 700 }}>
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
                        <td colSpan={4} style={{ paddingLeft: 20 }} title={gl.code}>
                          {gl.name ?? gl.code} <span className="faint mono" style={{ fontSize: 10 }}>{gl.code}</span>
                        </td>
                        <td className="mono faint" style={{ textAlign: 'right' }}>{gl.postings.toLocaleString()}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{money(gl.amount)}</td>
                        <td><ShareBar pctValue={grandTotal ? (gl.amount / grandTotal) * 100 : 0} color={meta.color} /></td>
                      </tr>
                      {glOpen && loadingGl === gl.code && (
                        <tr><td></td><td colSpan={7}><div className="empty">Loading…</div></td></tr>
                      )}
                      {glOpen && txns[gl.code]?.rows.map((r: any, i: number) => (
                        <tr key={i}>
                          <td></td>
                          <td style={{ paddingLeft: 40 }} className="mono faint" title={r.description ?? ''}>
                            {r.document_no}{r.description ? ` — ${r.description}` : ''}
                          </td>
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
          {tree.length > 0 && (
            <tr style={{ borderTop: '2px solid var(--border)' }}>
              <td></td>
              <td colSpan={4} style={{ fontWeight: 700 }}>Total</td>
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

export function Reports() {
  const { projectKey, project, dataVersion } = useApp();
  const [tab, setTab] = useState<Tab>('month');
  const [types, setTypes] = useState<CostTypeDef[]>([]);
  const [monthly, setMonthly] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  useEffect(() => {
    api.costTypes.types().then((r) => { if (r.ok) setTypes(r.data); });
  }, []);

  useEffect(() => {
    if (!projectKey) { setMonthly(null); return; }
    setBusy(true); setError(null);
    call(api.queries.run('COST_BY_TYPE_GL_MONTH', { project_key: projectKey }))
      .then(setMonthly)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [projectKey, dataVersion]);

  const rows = (monthly?.rows ?? []) as unknown as MonthRow[];

  /** Exports whichever tab is actually on screen, not always the monthly pivot. */
  const exportXlsx = async () => {
    setBusy(true); setError(null); setSavedTo(null);
    try {
      if (tab === 'month') {
        if (!monthly) return;
        setSavedTo(await call(api.exportResult(monthly, {
          title: 'Actuals by cost type, GL and month',
          subtitle: 'One row per cost type / GL / month — pivot and group in Excel as needed.',
          context: { Project: project?.project_code },
        })));
      } else {
        if (!projectKey) return;
        const all = await call(api.queries.run('COST_BY_TYPE_GL_TXN', { project_key: projectKey, cost_element_code: null }));
        setSavedTo(await call(api.exportResult(all, {
          title: 'Actual postings by cost type and GL',
          subtitle: 'Every individual posting behind Reports → Transactions, one row each.',
          context: { Project: project?.project_code },
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
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="segmented">
            <button className={tab === 'month' ? 'on' : ''} onClick={() => setTab('month')}>By month</button>
            <button className={tab === 'txn' ? 'on' : ''} onClick={() => setTab('txn')}>Transactions</button>
          </div>
          <button className="btn" onClick={exportXlsx} disabled={busy || !rows.length}>⤓ Excel</button>
        </div>

        <p className="hint">
          {tab === 'month'
            ? 'Actual cost by cost type and GL account, month by month. Share is each row\'s slice of total actual cost — click a column header to sort by it.'
            : 'The same grouping down to individual postings — expand a GL to load its transactions.'}
        </p>

        {busy && !monthly ? (
          <div className="empty">Loading…</div>
        ) : tab === 'month' ? (
          <MonthlyPivot rows={rows} types={types} />
        ) : (
          <TransactionTree rows={rows} types={types} />
        )}
      </div>
    </>
  );
}
