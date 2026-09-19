import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, call } from './lib/api';
import { Dashboard } from './pages/Dashboard';
import { Upload } from './pages/Upload';
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
}

const Ctx = createContext<AppState | null>(null);
export const useApp = (): AppState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <App>');
  return v;
};

type PageId = 'dashboard' | 'upload' | 'analysis' | 'reports' | 'costreport' | 'subcontractor' | 'material'
  | 'queries' | 'register' | 'schema' | 'pivot' | 'lineage' | 'settings';

/**
 * Groups double as nav sections and as the collapse unit below — "Advanced"
 * bundles the power-user/dev tools (raw SQL, free-form pivot, the schema
 * diagram) that the everyday "log data, see actual cost" workflow never
 * needs, so they start collapsed rather than sitting next to Reports/Settings.
 */
const PAGES: { id: PageId; label: string; glyph: string; group: string; subtitle: string }[] = [
  { id: 'dashboard', label: 'Dashboard', glyph: '◈', group: 'Overview', subtitle: 'Portfolio position and data freshness' },
  { id: 'upload', label: 'Upload data', glyph: '↥', group: 'Data', subtitle: 'Bring a report in, map it, review it, post it' },
  { id: 'register', label: 'Data register', glyph: '▤', group: 'Data', subtitle: 'Every import, its data date and audit trail' },
  { id: 'reports', label: 'Reports', glyph: '▦', group: 'Reports', subtitle: 'Cost type by GL by month, and the transactions behind it' },
  { id: 'costreport', label: 'Cost Report', glyph: '◫', group: 'Reports', subtitle: 'Work packages, accrual and indirect against plan — the numbers behind the issued report' },
  { id: 'subcontractor', label: 'Subcontractor Analysis', glyph: '▨', group: 'Reports', subtitle: 'Certified work, supplier concentration and PO reconciliation' },
  { id: 'material', label: 'Material Analysis', glyph: '▩', group: 'Reports', subtitle: 'Material spend by GL, WBS and vendor, with rate outliers' },
  { id: 'analysis', label: 'Analysis', glyph: '◨', group: 'Advanced', subtitle: 'Run a saved analysis and export it' },
  { id: 'pivot', label: 'Pivot builder', glyph: '⊞', group: 'Advanced', subtitle: 'Build a free-form cross-tab from any view' },
  { id: 'queries', label: 'Query library', glyph: '⌗', group: 'Advanced', subtitle: 'The SQL behind every report, stored in the database' },
  { id: 'schema', label: 'Schema diagram', glyph: '⛓', group: 'Advanced', subtitle: 'How the tables in the database relate to each other' },
  { id: 'lineage', label: 'Data lineage', glyph: '⤳', group: 'Advanced', subtitle: 'From an uploaded report through to every query that reads it' },
  { id: 'settings', label: 'Settings', glyph: '⚙', group: 'Admin', subtitle: 'Projects, database and backups' },
];
const COLLAPSIBLE_GROUP = 'Advanced';
const ADVANCED_OPEN_KEY = 'ci.nav.advancedOpen';

export default function App() {
  const [page, setPage] = useState<PageId>('dashboard');
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectKey, setProjectKey] = useState<number | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [info, setInfo] = useState<{ version: string; dbPath: string } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    try { return localStorage.getItem(ADVANCED_OPEN_KEY) === '1'; } catch { return false; }
  });

  const refresh = useCallback(async () => {
    const rows = await call(api.projects.list());
    setProjects(rows as ProjectRow[]);
    setProjectKey((k) => (k && rows.some((r: ProjectRow) => r.project_key === k) ? k : rows[0]?.project_key ?? null));
  }, []);

  useEffect(() => {
    refresh().catch((e) => console.error(e));
    api.app.info().then((r) => { if (r.ok) setInfo(r.data); });
  }, [refresh]);

  const state = useMemo<AppState>(() => ({
    projects,
    projectKey,
    setProjectKey,
    project: projects.find((p) => p.project_key === projectKey) ?? null,
    refresh,
    dataVersion,
    touch: () => setDataVersion((v) => v + 1),
  }), [projects, projectKey, refresh, dataVersion]);

  const current = PAGES.find((p) => p.id === page)!;
  const groups = [...new Set(PAGES.map((p) => p.group))];

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
                  ) : (
                    <div className="nav-group">{g}</div>
                  )}
                  {collapsible && open && (
                    <div className="hint" style={{ padding: '0 10px', marginBottom: 6, fontSize: 11 }}>
                      SQL, pivot tables and the schema — for building new reports.
                    </div>
                  )}
                  {open && PAGES.filter((p) => p.group === g).map((p) => (
                    <button
                      key={p.id}
                      className={`nav-item ${page === p.id ? 'active' : ''}`}
                      onClick={() => setPage(p.id)}
                    >
                      <span className="glyph">{p.glyph}</span>
                      {p.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>

          <div className="sidebar-foot">
            v{info?.version ?? '—'}
            <br />
            {info?.dbPath ?? ''}
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <h2>{current.label}</h2>
              <div className="sub">{current.subtitle}</div>
            </div>
            <div className="spacer" />
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
            {page === 'dashboard' && <Dashboard />}
            {page === 'upload' && <Upload onDone={() => { state.touch(); refresh(); }} />}
            {page === 'register' && <DataRegister />}
            {page === 'analysis' && <Analysis />}
            {page === 'reports' && <Reports />}
            {page === 'costreport' && <CostReport />}
            {page === 'subcontractor' && <SubcontractorAnalysis />}
            {page === 'material' && <MaterialAnalysis />}
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
