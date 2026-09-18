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

type PageId = 'dashboard' | 'upload' | 'analysis' | 'reports' | 'subcontractor' | 'material' | 'queries' | 'register' | 'schema' | 'settings';

const PAGES: { id: PageId; label: string; glyph: string; group: string; subtitle: string }[] = [
  { id: 'dashboard', label: 'Dashboard', glyph: '◈', group: 'Overview', subtitle: 'Portfolio position and data freshness' },
  { id: 'upload', label: 'Upload data', glyph: '↥', group: 'Data', subtitle: 'Bring a report in, map it, review it, post it' },
  { id: 'register', label: 'Data register', glyph: '▤', group: 'Data', subtitle: 'Every import, its data date and audit trail' },
  { id: 'analysis', label: 'Analysis', glyph: '◨', group: 'Reporting', subtitle: 'Run a saved analysis and export it' },
  { id: 'reports', label: 'Reports', glyph: '▦', group: 'Reporting', subtitle: 'Cost type by GL by month, and the transactions behind it' },
  { id: 'subcontractor', label: 'Subcontractor Analysis', glyph: '▨', group: 'Reporting', subtitle: 'Certified work, supplier concentration and PO reconciliation' },
  { id: 'material', label: 'Material Analysis', glyph: '▩', group: 'Reporting', subtitle: 'Material spend by GL, WBS and vendor, with rate outliers' },
  { id: 'queries', label: 'Query library', glyph: '⌗', group: 'Reporting', subtitle: 'The SQL behind every report, stored in the database' },
  { id: 'schema', label: 'Schema diagram', glyph: '⛓', group: 'Admin', subtitle: 'How the tables in the database relate to each other' },
  { id: 'settings', label: 'Settings', glyph: '⚙', group: 'Admin', subtitle: 'Projects, database and backups' },
];

export default function App() {
  const [page, setPage] = useState<PageId>('dashboard');
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectKey, setProjectKey] = useState<number | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [info, setInfo] = useState<{ version: string; dbPath: string } | null>(null);

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
            {groups.map((g) => (
              <div key={g}>
                <div className="nav-group">{g}</div>
                {PAGES.filter((p) => p.group === g).map((p) => (
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
            ))}
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
            {page === 'subcontractor' && <SubcontractorAnalysis />}
            {page === 'material' && <MaterialAnalysis />}
            {page === 'queries' && <QueryLibrary />}
            {page === 'schema' && <SchemaDiagram />}
            {page === 'settings' && <Settings />}
          </div>
        </main>
      </div>
    </Ctx.Provider>
  );
}
