import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, call } from './lib/api';
import { Dashboard } from './pages/Dashboard';
import { Home } from './pages/Home';
import { Analysis } from './pages/Analysis';
import { Reports } from './pages/Reports';
import { SubcontractorAnalysis } from './pages/SubcontractorAnalysis';
import { MaterialAnalysis } from './pages/MaterialAnalysis';
import { QueryLibrary } from './pages/QueryLibrary';
import { DataRegister } from './pages/DataRegister';
import { Settings } from './pages/Settings';
import { SchemaDiagram } from './pages/SchemaDiagram';
import { PivotBuilder } from './pages/PivotBuilder';
import { LineageGraph } from './pages/LineageGraph';
import { CostReport } from './pages/CostReport';
import { Coding, type CodingTab } from './pages/Coding';
import { Register } from './pages/Register';

export interface ProjectRow {
  project_key: number;
  project_code: string;
  project_name: string;
  currency_code: string | null;
}

interface AppState {
  projects: ProjectRow[];
  projectKey: number | null;
  setProjectKey: (k: number | null) => void;
  project: ProjectRow | null;
  refresh: () => Promise<void>;
  /** Bumped whenever data changes, so pages can re-query. */
  dataVersion: number;
  touch: () => void;
  /** Project cut-off status; null until loaded (or no project). */
  cutoff: CutoffStatus | null;
  setCutoff: (date: string | null) => Promise<void>;
  /** Show the builder tools (Analysis, Pivot, Query library, Schema, Lineage) in the menu. */
  devTools: boolean;
  setDevTools: (on: boolean) => void;
}

export interface CutoffStatus {
  cutoff_date: string | null;
  latest_posting_date: string | null;
  earliest_posting_date: string | null;
  lines_after_cutoff: number;
  amount_after_cutoff: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' -> '31 Mar 2026' (no Date parsing, so no timezone shift). */
/**
 * Cut-off choices: the month ends from the later of this month and the latest posting back to the
 * project's first posting month (12 months when nothing is loaded yet). Plain arithmetic on
 * year/month — no Date parsing of ISO strings, so no timezone shift.
 */
function monthEnds(earliest: string | null, latest: string | null): string[] {
  const ym = (iso: string | null) => { const m = iso ? /^(\d{4})-(\d{2})/.exec(iso) : null; return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null; };
  const now = new Date();
  const top = Math.max(now.getFullYear() * 12 + now.getMonth(), ym(latest) ?? -Infinity);
  const bottom = Math.min(ym(earliest) ?? top - 11, top);
  const out: string[] = [];
  for (let i = top; i >= bottom; i--) {
    const y = Math.floor(i / 12), m = (i % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`);
  }
  return out;
}

function fmtDay(iso: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return iso ?? '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = (): AppState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <App>');
  return v;
};

type PageId = 'home' | 'coding' | 'register_cost' | 'dashboard' | 'costtypes' | 'packages' | 'analysis' | 'reports' | 'costreport' | 'subcontractor' | 'material'
  | 'queries' | 'register' | 'schema' | 'pivot' | 'lineage' | 'settings';

/**
 * Groups double as nav sections and as the collapse unit below — "Advanced"
 * bundles the power-user/dev tools (raw SQL, free-form pivot, the schema
 * diagram) that the everyday "log data, see actual cost" workflow never
 * needs, so they start collapsed rather than sitting next to Reports/Settings.
 */
const HOME_GROUP = 'Home';
const PAGES: { id: PageId; label: string; glyph: string; group: string; subtitle: string }[] = [
  { id: 'home', label: 'Home', glyph: '◈', group: HOME_GROUP, subtitle: 'Load the SAP files into the cost-source map, see what is missing, open the reports' },
  { id: 'register', label: 'Loaded files', glyph: '▤', group: HOME_GROUP, subtitle: 'Every import, its data date and audit trail' },
  { id: 'coding', label: 'Coding', glyph: '◐', group: HOME_GROUP, subtitle: 'GL accounts to cost types, materials and subcontract services to work packages' },
  { id: 'register_cost', label: 'Actual cost register', glyph: '▦', group: 'Reports', subtitle: 'Actual cost per month and cumulative, for every cost type, to the cut-off' },
  { id: 'dashboard', label: 'Project dashboard', glyph: '◇', group: 'Advanced', subtitle: 'Budget, actual to cut-off, S-curve and where the money goes' },
  { id: 'reports', label: 'Actual cost (GL pivot)', glyph: '▦', group: 'Advanced', subtitle: 'Cost type by GL by month, and the transactions behind it' },
  { id: 'costreport', label: 'Cost Report', glyph: '◫', group: 'Advanced', subtitle: 'Work packages, accrual and indirect against plan — the numbers behind the issued report' },
  { id: 'subcontractor', label: 'Subcontractors', glyph: '▨', group: 'Reports', subtitle: 'Certified work, supplier concentration and PO reconciliation' },
  { id: 'material', label: 'Materials', glyph: '▩', group: 'Reports', subtitle: 'Material spend by GL, WBS and vendor, with rate outliers' },
  { id: 'analysis', label: 'Analysis', glyph: '◨', group: 'Advanced', subtitle: 'Run a saved analysis and export it' },
  { id: 'pivot', label: 'Pivot builder', glyph: '⊞', group: 'Advanced', subtitle: 'Build a free-form cross-tab from any view' },
  { id: 'queries', label: 'Query library', glyph: '⌗', group: 'Advanced', subtitle: 'The SQL behind every report, stored in the database' },
  { id: 'schema', label: 'Schema diagram', glyph: '⛓', group: 'Advanced', subtitle: 'How the tables in the database relate to each other' },
  { id: 'lineage', label: 'Data lineage', glyph: '⤳', group: 'Advanced', subtitle: 'From an uploaded report through to every query that reads it' },
  { id: 'settings', label: 'Settings', glyph: '⚙', group: 'Admin', subtitle: 'Projects, database and backups' },
];
const COLLAPSIBLE_GROUP = 'Advanced';
const DEV_TOOLS_KEY = 'ci.devTools';
const ADVANCED_OPEN_KEY = 'ci.nav.advancedOpen';

export default function App() {
  const [page, setPage] = useState<PageId>('home');
  const [codingTab, setCodingTab] = useState<CodingTab | undefined>();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectKey, setProjectKey] = useState<number | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [cutoff, setCutoffState] = useState<CutoffStatus | null>(null);
  const [info, setInfo] = useState<{ version: string; dbPath: string } | null>(null);
  // The builder tools stay out of the menu unless switched on in Settings (per computer).
  const [devTools, setDevToolsState] = useState(() => {
    try { return localStorage.getItem(DEV_TOOLS_KEY) === '1'; } catch { return false; }
  });
  const setDevTools = useCallback((on: boolean) => {
    setDevToolsState(on);
    if (on) setAdvancedOpen(true);   // switched on to be used: show the group open
    try { localStorage.setItem(DEV_TOOLS_KEY, on ? '1' : '0'); } catch { /* per-viewer convenience */ }
  }, []);
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    try { return localStorage.getItem(ADVANCED_OPEN_KEY) === '1'; } catch { return false; }
  });
  /**
   * Every in-app link goes through here. The old Cost types / Work packages pages are tabs of Coding now, so
   * 'costtypes' opens its GL tab, 'packages' opens the first tab with something to code, and
   * 'coding:<tab>' opens that tab.
   */
  const navigate = useCallback((target: string) => {
    if (target === 'costtypes') { setCodingTab('gl'); setPage('coding'); return; }
    if (target === 'packages') { setCodingTab(undefined); setPage('coding'); return; }
    if (target.startsWith('coding:')) { setCodingTab(target.slice(7) as CodingTab); setPage('coding'); return; }
    if (target === 'coding') setCodingTab(undefined);
    // the three report pages the register replaced live in developer tools; without them, links land on the register
    if (!devTools && (target === 'dashboard' || target === 'reports' || target === 'costreport')) { setPage('register_cost'); return; }
    setPage(target as PageId);
  }, [devTools]);

  const refresh = useCallback(async () => {
    const rows = await call(api.projects.list());
    setProjects(rows as ProjectRow[]);
    setProjectKey((k) => (k && rows.some((r: ProjectRow) => r.project_key === k) ? k : rows[0]?.project_key ?? null));
  }, []);

  useEffect(() => {
    refresh().catch((e) => console.error(e));
    api.app.info().then((r) => { if (r.ok) setInfo(r.data); });
  }, [refresh]);

  const touch = useCallback(() => setDataVersion((v) => v + 1), []);

  // A file dropped anywhere but a drop target would make Electron navigate to it and replace the app.
  useEffect(() => {
    const stop = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);

  const loadCutoff = useCallback(async (k: number | null) => {
    if (k == null) { setCutoffState(null); return; }
    try {
      const r = await api.cutoff.get(k);
      setCutoffState(r.ok ? (r.data as CutoffStatus) : null);
    } catch { setCutoffState(null); }
  }, []);

  useEffect(() => { loadCutoff(projectKey); }, [loadCutoff, projectKey, dataVersion]);

  const setCutoff = useCallback(async (date: string | null) => {
    if (projectKey == null) return;
    await call(api.cutoff.set(projectKey, date));
    await loadCutoff(projectKey);
    touch();
  }, [projectKey, loadCutoff, touch]);

  const cutoffOptions = useMemo(() => {
    const list = monthEnds(cutoff?.earliest_posting_date ?? null, cutoff?.latest_posting_date ?? null);
    // a cut-off saved earlier that is not a listed month end stays selectable
    if (cutoff?.cutoff_date && !list.includes(cutoff.cutoff_date)) list.push(cutoff.cutoff_date);
    return list.sort().reverse();
  }, [cutoff?.earliest_posting_date, cutoff?.latest_posting_date, cutoff?.cutoff_date]);

  const state = useMemo<AppState>(() => ({
    projects,
    projectKey,
    setProjectKey,
    project: projects.find((p) => p.project_key === projectKey) ?? null,
    refresh,
    dataVersion,
    touch,
    cutoff,
    setCutoff,
    devTools,
    setDevTools,
  }), [projects, projectKey, refresh, dataVersion, touch, cutoff, setCutoff, devTools, setDevTools]);

  const navPages = useMemo(() => (devTools ? PAGES : PAGES.filter((p) => p.group !== COLLAPSIBLE_GROUP)), [devTools]);
  // switching the tools off while on one of their pages returns to Home
  useEffect(() => { if (!navPages.some((p) => p.id === page)) setPage('home'); }, [navPages, page]);
  const current = navPages.find((p) => p.id === page) ?? PAGES[0];
  const groups = [...new Set(navPages.map((p) => p.group))];
  const activeGroup = current.group;

  return (
    <Ctx.Provider value={state}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="mark">CI</div>
            <div>
              <h1>Cost Intelligence</h1>
              <span>Project cost control</span>
            </div>
          </div>

          <nav className="nav">
            {groups.map((g) => {
              const collapsible = g === COLLAPSIBLE_GROUP;
              const open = !collapsible || advancedOpen;
              return (
                <div key={g}>
                  {collapsible ? (
                    <button
                      className="nav-group"
                      style={{ display: 'flex', alignItems: 'center', width: '100%', cursor: 'pointer',
                               background: 'none', border: 0, padding: '0 10px' }}
                      onClick={() => {
                        const next = !advancedOpen;
                        setAdvancedOpen(next);
                        try { localStorage.setItem(ADVANCED_OPEN_KEY, next ? '1' : '0'); } catch { /* ignore */ }
                      }}
                    >
                      <span style={{ marginRight: 6, fontSize: 9 }}>{open ? '▾' : '▸'}</span>
                      {g}
                    </button>
                  ) : g === HOME_GROUP ? null : /^\d · /.test(g) ? (
                    <div className={`nav-group step-group ${activeGroup === g ? 'active' : ''}`}>
                      <span className="step-marker">{g[0]}</span>
                      {g.slice(4)}
                    </div>
                  ) : (
                    <div className="nav-group">{g}</div>
                  )}
                  {collapsible && open && (
                    <div className="hint" style={{ padding: '0 10px', marginBottom: 6, fontSize: 11 }}>
                      SQL, pivot tables and the schema — for building new reports.
                    </div>
                  )}
                  {open && navPages.filter((p) => p.group === g).map((p) => (
                    <button
                      key={p.id}
                      className={`nav-item ${page === p.id ? 'active' : ''}`}
                      onClick={() => navigate(p.id)}
                    >
                      <span className="glyph">{p.glyph}</span>
                      {p.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>

          <div className="sidebar-foot" title={info?.dbPath ?? ''}>
            v{info?.version ?? '—'}
            <br />
            {info?.dbPath ? info.dbPath.split(/[\\/]/).pop() : ''}
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <h2>{current.label}</h2>
              <div className="sub">{current.subtitle}</div>
            </div>
            <div className="spacer" />
            {projectKey != null && (
              <div className="cutoff-ctl">
                <div className="cutoff-row">
                  <label className="cutoff-pill" title="Only postings dated on or before this day count">
                    <span aria-hidden>▦</span>
                    <select
                      className="cutoff-select"
                      value={cutoff?.cutoff_date ?? ''}
                      onChange={(e) => setCutoff(e.target.value || null).catch((err) => console.error(err))}
                    >
                      <option value="">No cut-off</option>
                      {cutoffOptions.map((d) => <option key={d} value={d}>Cut-off {fmtDay(d)}</option>)}
                    </select>
                    <span aria-hidden style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
                  </label>
                  {cutoff?.cutoff_date && (
                    <button
                      className="cutoff-clear"
                      title="Clear the cut-off (count all data)"
                      onClick={() => setCutoff(null).catch((err) => console.error(err))}
                    >×</button>
                  )}
                </div>
                {cutoff?.latest_posting_date && (
                  <div className="cutoff-note">
                    latest posting {fmtDay(cutoff.latest_posting_date)}
                    {cutoff.lines_after_cutoff > 0 && ` · ${cutoff.lines_after_cutoff.toLocaleString()} lines after cut-off`}
                  </div>
                )}
              </div>
            )}
            {projects.length > 0 && (
              <label className="field" style={{ minWidth: 260 }}>
                <select
                  value={projectKey ?? ''}
                  onChange={(e) => setProjectKey(e.target.value ? Number(e.target.value) : null)}
                >
                  {projects.map((p) => (
                    <option key={p.project_key} value={p.project_key}>
                      {p.project_code} — {p.project_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </header>

          <div className="content">
            {page === 'home' && <Home onNavigate={navigate} />}
            {page === 'dashboard' && <Dashboard />}
            {page === 'register' && <DataRegister />}
            {page === 'coding' && <Coding tab={codingTab} onTab={setCodingTab} />}
            {page === 'register_cost' && <Register />}
            {page === 'analysis' && <Analysis />}
            {page === 'reports' && <Reports />}
            {page === 'costreport' && <CostReport />}
            {page === 'subcontractor' && <SubcontractorAnalysis onNavigate={() => navigate('coding:services')} />}
            {page === 'material' && <MaterialAnalysis onNavigate={() => navigate('coding:materials')} />}
            {page === 'queries' && <QueryLibrary />}
            {page === 'schema' && <SchemaDiagram />}
            {page === 'pivot' && <PivotBuilder />}
            {page === 'lineage' && <LineageGraph />}
            {page === 'settings' && <Settings />}
          </div>
        </main>
      </div>
    </Ctx.Provider>
  );
}
