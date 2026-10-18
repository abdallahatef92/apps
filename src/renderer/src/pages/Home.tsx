import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { ArchMap } from '../components/ArchMap';
import { Upload } from './Upload';
import type { BuildCheck, BuildStatus, BuildStepStatus, BuildTimelineBar, Module, QueryResult, ReportReadiness } from '@shared/types';

type Target = 'register' | 'packages' | 'reports' | 'costtypes' | 'settings'
  | 'costreport' | 'subcontractor' | 'material' | 'dashboard';

const STATUS_DOT: Record<BuildStatus, string> = {
  'Complete': 'good', 'Behind cut-off': 'warn', 'Needs action': 'warn', 'Ready to load': 'accent',
  'Waiting': 'wait', 'Optional': 'ring', 'Not available': 'ring',
};
const READY_INK: Record<ReportReadiness['status'], string> = {
  'Ready': 'var(--good)', 'Builds with gaps': 'var(--badge-warn-ink)',
  'Behind cut-off': 'var(--badge-warn-ink)', 'Waiting': 'var(--text-3)',
};
const CHECK_ICON: Record<BuildCheck['level'], string> = { ok: '✓', warn: '!', todo: '○' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> month index (y*12+m-1) plus the fraction of that month passed at the start / end of the day. */
function datePos(iso: string, end: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m || Number(m[1]) < 1900 || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return y * 12 + mo - 1 + (end ? d : d - 1) / days;
}
const ymOf = (iso: string | null) => (iso ? Math.floor(datePos(iso, false) ?? NaN) : NaN);
const fmtDay = (iso: string | null) => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—';
};

interface Axis { start: number; count: number; cut: number | null }
const VIEW_KEY = 'ci.home.view';

/** The build workspace: which inputs are in, what is missing, and which reports can be opened. */
export function Home({ onNavigate }: { onNavigate: (page: Target) => void }) {
  const { projectKey, dataVersion, cutoff, touch, refresh } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<BuildStepStatus[]>([]);
  const [checks, setChecks] = useState<BuildCheck[]>([]);
  const [timeline, setTimeline] = useState<BuildTimelineBar[]>([]);
  const [readiness, setReadiness] = useState<ReportReadiness[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const readinessRef = useRef<HTMLDivElement>(null);
  // Map (the cost-source architecture) or Timeline (the Gantt); remembered per computer.
  const [view, setView] = useState<'map' | 'timeline'>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'timeline' ? 'timeline' : 'map'; } catch { return 'map'; }
  });
  const pickView = (v: 'map' | 'timeline') => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience */ } };
  // The upload wizard, opened from a card (preset to its report) or from "Add file" (no preset).
  const [upload, setUpload] = useState<{ step: BuildStepStatus | null; path: string | null; n: number } | null>(null);
  const openUpload = (step: BuildStepStatus | null, path?: string) =>
    setUpload((u) => ({ step, path: path ?? null, n: (u?.n ?? 0) + 1 }));

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        // No project yet (a new database): project 0 matches nothing, so every step reads as not loaded
        // and the map still shows what to load.
        const pk = projectKey ?? 0;
        // cheapest first, so the step list and the cards show while the detail checks still run
        setSteps(await call(api.build.status(pk)));
        setTimeline(await call(api.build.timeline(pk)));
        setReadiness(await call(api.build.readiness(pk)));
        setChecks(await call(api.build.checks(pk)));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [projectKey, dataVersion]);

  const sortedSteps = useMemo(() => [...steps].sort((a, b) => a.sort_order - b.sort_order), [steps]);
  const groups = useMemo(() => {
    const out: { label: string; rows: BuildStepStatus[] }[] = [];
    for (const r of sortedSteps) {
      const g = out.find((x) => x.label === r.group_label);
      if (g) g.rows.push(r); else out.push({ label: r.group_label, rows: [r] });
    }
    return out;
  }, [sortedSteps]);
  const cutoffDate = cutoff?.cutoff_date ?? null;
  // Months across the chart: every file's dates (or data date), the cut-off, and at least 6 months.
  const axis = useMemo<Axis | null>(() => {
    const ms: number[] = [];
    for (const b of timeline) {
      for (const d of [b.date_from, b.date_to, b.data_date]) { const v = ymOf(d); if (!Number.isNaN(v)) ms.push(v); }
    }
    const cutM = ymOf(cutoffDate);
    if (!Number.isNaN(cutM)) ms.push(cutM);
    if (ms.length === 0) return null;
    const lo = Math.min(...ms), hi = Math.max(...ms);
    const count = Math.max(hi - lo + 1, 6);
    return { start: hi - count + 1 < lo ? hi - count + 1 : lo, count, cut: cutoffDate ? datePos(cutoffDate, true) : null };
  }, [timeline, cutoffDate]);
  const barsByStep = useMemo(() => {
    const m = new Map<string, BuildTimelineBar[]>();
    for (const b of timeline) { const l = m.get(b.step_code) ?? []; l.push(b); m.set(b.step_code, l); }
    return m;
  }, [timeline]);
  const pctOf = (pos: number) => axis ? ((pos - axis.start) / axis.count) * 100 : 0;

  const requiredRows = steps.filter((r) => !r.is_optional);
  const completeReq = requiredRows.filter((r) => r.status === 'Complete').length;
  const needAction = steps.filter((r) => r.status === 'Needs action' || r.status === 'Behind cut-off').length;
  const selected = sortedSteps.find((r) => r.step_code === selectedCode)
    ?? sortedSteps.find((r) => r.status === 'Needs action')
    ?? sortedSteps.find((r) => r.status === 'Ready to load')
    ?? sortedSteps[0];
  const selectedChecks = selected ? checks.filter((c) => c.step_code === selected.step_code) : [];

  // The report checks behind B07 / B06 take seconds on real data, so they load only for the selected step.
  const [sourceWarn, setSourceWarn] = useState<{ step: string; rows: string[] } | null>(null);
  const warnStep = selected && selected.has_data && (selected.step_code === 'B07' || selected.step_code === 'B06')
    ? selected.step_code : null;
  useEffect(() => {
    if (!warnStep || !projectKey) return;
    let live = true;
    (async () => {
      try {
        const sc = warnStep === 'B07';
        const r: QueryResult = await call(api.queries.run(sc ? 'SC_CHECKS' : 'MAT_CHECKS', { project_key: projectKey }));
        const rows = r.rows
          .filter((x) => (sc ? Number(x.needs_attention) === 1 : x.status === 'warn'))
          .map((x) => `${sc ? x.check : x.check_name} (${Number((sc ? x.count : x.lines) ?? 0)}): ${x.detail ?? ''}`);
        if (live) setSourceWarn({ step: warnStep, rows });
      } catch { /* the step's own checks are still shown */ }
    })();
    return () => { live = false; };
  }, [warnStep, projectKey, dataVersion]);
  const extraWarn = sourceWarn && sourceWarn.step === warnStep ? sourceWarn.rows : [];
  const loadingWarn = !!warnStep && !(sourceWarn && sourceWarn.step === warnStep);

  return (
    <>
      {error && <div className="banner err">{error}</div>}

      <div className="build-head">
        <div className="build-head-text">
          <strong>{completeReq} of {requiredRows.length} required inputs complete</strong>
          <span className="faint"> · {needAction} need{needAction === 1 ? 's' : ''} action</span>
          <div className="flow-meter build-meter" style={{ ['--c' as string]: 'var(--good)' }}>
            <span style={{ width: `${requiredRows.length ? Math.round((completeReq / requiredRows.length) * 100) : 0}%` }} />
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="link-btn" onClick={() => { pickView(view === 'map' ? 'timeline' : 'map'); setUpload(null); }}>
            {view === 'map' ? 'Timeline view' : 'Map view'}
          </button>
          <button className="btn sm" onClick={() => openUpload(null)}>Add file</button>
          <button className="btn sm primary"
                  onClick={() => readinessRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            Open reports
          </button>
        </div>
      </div>

      {upload ? (
        <div className="upload-panel">
          <Upload key={upload.n}
                  preset={upload.step?.module ? {
                    module: upload.step.module as Module, reportId: upload.step.report_definition_id,
                    title: `${upload.step.step_code} · ${upload.step.name}`,
                  } : undefined}
                  initialPath={upload.path}
                  onClose={() => setUpload(null)}
                  onDone={() => { touch(); refresh(); }}
                  onNavigate={(pg) => { setUpload(null); onNavigate(pg); }} />
          {!upload.step && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setUpload(null)}>← Back to the map</button>}
        </div>
      ) : steps.length === 0 ? (
        <div className="card"><div className="empty">Loading the build steps…</div></div>
      ) : (
        <div className="build-area">
          {view === 'map' ? (
            <div className="card arch-card-wrap">
              <ArchMap steps={sortedSteps} bars={barsByStep} selectedCode={selected?.step_code ?? null}
                       onSelect={setSelectedCode} onLoad={(s, path) => openUpload(s, path)} />
            </div>
          ) : (
          <div className="card build-grid">
            <table>
              <colgroup><col style={{ width: 48 }} /><col style={{ width: 190 }} /><col style={{ width: 118 }} /><col /></colgroup>
              <thead>
                <tr>
                  <th>ID</th><th>Step</th><th>Status</th>
                  <th className="gantt-th">
                    {axis ? (
                      <div className="gantt-months">
                        {Array.from({ length: axis.count }, (_, i) => {
                          const ym = axis.start + i, mo = ym % 12;
                          const label = axis.count > 18 ? MONTHS[mo][0] : MONTHS[mo];
                          return <span key={ym} title={`${MONTHS[mo]} ${Math.floor(ym / 12)}`}>
                            <span className="yr">{mo === 0 || i === 0 ? Math.floor(ym / 12) : ' '}</span>
                            {label}
                          </span>;
                        })}
                      </div>
                    ) : 'Timeline'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.label}>
                    <tr className="build-group">
                      <td colSpan={3}>{g.label}</td>
                      <td className="gantt-cell">{axis && <GanttTrack axis={axis} pctOf={pctOf} />}</td>
                    </tr>
                    {g.rows.map((r) => (
                      <tr key={r.step_code} className={r.step_code === selected?.step_code ? 'sel' : ''}
                          onClick={() => setSelectedCode(r.step_code)}>
                        <td className="mono">{r.step_code}</td>
                        <td title={r.name}>{r.name}</td>
                        <td><span className="build-status"><span className={`sdot ${STATUS_DOT[r.status]}`} />{r.status}</span></td>
                        <td className="gantt-cell">
                          {axis && <GanttTrack axis={axis} pctOf={pctOf} bars={barsByStep.get(r.step_code) ?? []}
                                               behind={r.status === 'Behind cut-off'}
                                               empty={emptyLabel(r, barsByStep.has(r.step_code))} />}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          )}

          {selected && (
            <div className="card build-detail">
              <div className="faint mono" style={{ fontSize: 11 }}>{selected.step_code}</div>
              <h4 className="build-detail-title">{selected.name}</h4>
              <p className="build-summary">{selected.summary}</p>
              <span className="build-status" style={{ marginBottom: 8 }}>
                <span className={`sdot ${STATUS_DOT[selected.status]}`} />{selected.status}
              </span>
              {(barsByStep.get(selected.step_code) ?? []).length > 0 && (
                <ul className="build-files">
                  {(barsByStep.get(selected.step_code) ?? []).map((b) => (
                    <li key={b.import_batch_id}>
                      <span className="build-file-name" title={b.file_name ?? ''}>{b.file_name ?? `Batch ${b.import_batch_id}`}</span>
                      <span className="faint">
                        {b.date_from ? `${fmtDay(b.date_from)} – ${fmtDay(b.date_to)}` : `data date ${fmtDay(b.data_date)}`}
                        {b.lines > 0 && ` · ${b.lines.toLocaleString()} lines`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {(selectedChecks.length > 0 || extraWarn.length > 0 || loadingWarn) && (
                <ul className="build-checks">
                  {selectedChecks.map((c, i) => (
                    <li key={i}><span className={`cicon ${c.level}`}>{CHECK_ICON[c.level]}</span>{c.message}</li>
                  ))}
                  {extraWarn.map((m, i) => (
                    <li key={`w${i}`}><span className="cicon warn">{CHECK_ICON.warn}</span>{m}</li>
                  ))}
                  {loadingWarn && <li className="faint">Running the report checks…</li>}
                </ul>
              )}
              {selected.depends_on && <div className="build-rel"><span className="faint">Depends on</span> {selected.depends_on}</div>}
              {selected.feeds && <div className="build-rel"><span className="faint">Feeds</span> {selected.feeds.split(',').map((x) => x.trim()).join(', ')}</div>}
              {selected.action_label && selected.action_target && (
                <button className="btn primary sm" style={{ alignSelf: 'flex-start', marginTop: 10 }}
                        onClick={() => (selected.action_target === 'upload'
                          ? openUpload(selected) : onNavigate(selected.action_target as Target))}>
                  {selected.action_label}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {readiness.length > 0 && (
        <div className="ready-strip" ref={readinessRef}>
          {readiness
            // one card for the actual cost register (it replaced Project dashboard / Actual cost / Cost Report)
            .filter((r) => r.report_page !== 'dashboard' && r.report_page !== 'costreport')
            .map((r) => (r.report_page === 'reports' ? { ...r, label: 'Actual cost register' } : r))
            .map((r) => (
            <button key={r.report_page} className="ready-card" onClick={() => onNavigate(r.report_page as Target)}>
              <span className="ready-label">{r.label}</span>
              <span className="ready-status" style={{ color: READY_INK[r.status] }}>{r.status}</span>
              {r.missing && <span className="ready-missing">{r.missing}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** What an empty Gantt row says: why there is no bar. */
function emptyLabel(r: BuildStepStatus, hasFiles: boolean): string {
  if (hasFiles) return '';
  if (r.kind === 'coding') return 'Coding step';
  if (r.kind !== 'upload') return '';
  if (r.status === 'Not available') return 'SAP report not available yet';
  return r.is_optional ? 'Not loaded · optional' : 'Not loaded';
}

/**
 * One row of the build Gantt: faint month lines, the cut-off line, and a bar per attached file
 * from its first to its last date (a diamond at the data date when the file carries no dates).
 * A month no file covers between two bars is drawn as a dashed gap.
 */
function GanttTrack({ axis, pctOf, bars = [], behind = false, empty = '' }: {
  axis: Axis; pctOf: (pos: number) => number; bars?: BuildTimelineBar[]; behind?: boolean; empty?: string;
}) {
  const dated = bars.filter((b) => b.date_from && b.date_to)
    .sort((x, y) => (x.date_from! < y.date_from! ? -1 : 1));
  const gaps: { from: number; to: number }[] = [];
  let reach = dated.length ? datePos(dated[0].date_to!, true)! : 0;
  for (let i = 1; i < dated.length; i++) {
    const nextStart = datePos(dated[i].date_from!, false)!;
    if (Math.floor(nextStart) - Math.floor(reach) > 1) gaps.push({ from: reach, to: nextStart });
    reach = Math.max(reach, datePos(dated[i].date_to!, true)!);
  }
  const lastId = dated.length ? dated.reduce((p, b) => (b.date_to! > p.date_to! ? b : p)).import_batch_id : null;
  return (
    <div className="gantt-track" style={{ ['--gantt-n' as string]: axis.count }}>
      {gaps.map((g, i) => (
        <div key={`g${i}`} className="gantt-gap" style={{ left: `${pctOf(g.from)}%`, width: `${pctOf(g.to) - pctOf(g.from)}%` }}
             title="No file covers these months" />
      ))}
      {dated.map((b) => {
        const l = pctOf(datePos(b.date_from!, false)!), r = pctOf(datePos(b.date_to!, true)!);
        return (
          <div key={b.import_batch_id} className={`gantt-bar${behind && b.import_batch_id === lastId ? ' late' : ''}`}
               style={{ left: `${l}%`, width: `${Math.max(r - l, 0.6)}%` }}
               title={`${b.file_name ?? 'File'}\n${fmtDay(b.date_from)} – ${fmtDay(b.date_to)} · ${b.lines.toLocaleString()} lines · data date ${fmtDay(b.data_date)}`} />
        );
      })}
      {bars.filter((b) => !b.date_from && b.data_date).map((b) => (
        <div key={b.import_batch_id} className="gantt-mark" style={{ left: `${pctOf(datePos(b.data_date!, true)!)}%` }}
             title={`${b.file_name ?? 'File'}\nNo dates in the file · data date ${fmtDay(b.data_date)}`} />
      ))}
      {bars.length === 0 && empty && <span className="gantt-empty">{empty}</span>}
      {axis.cut != null && <div className="gantt-cut" style={{ left: `${pctOf(axis.cut)}%` }} />}
    </div>
  );
}
