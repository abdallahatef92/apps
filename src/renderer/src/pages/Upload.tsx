import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { periodOf, today } from '../lib/format';
import type {
  ColumnMappingEntry, FilePreview, Module, PostResult, ReportDefinition,
  SheetPreview, StageResult, TargetField,
} from '@shared/types';

type Step = 1 | 2 | 3 | 4;

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Source & file' },
  { n: 2, label: 'Sheet & data date' },
  { n: 3, label: 'Column mapping' },
  { n: 4, label: 'Review & post' },
];

const MODULES: { code: Module; label: string; hint: string }[] = [
  { code: 'ACTUAL', label: 'Actuals', hint: 'Posted cost from SAP' },
  { code: 'BUDGET', label: 'Budget', hint: 'Approved budget by WBS' },
  { code: 'FORECAST', label: 'Forecast', hint: 'ETC / EAC by period' },
  { code: 'SERVICE', label: 'Service lines', hint: 'Subcontractor detail behind a PO — reconciled against actuals, never added to them' },
  { code: 'MASTER', label: 'WBS structure', hint: 'Project breakdown structure' },
];

export function Upload({ onDone }: { onDone: () => void }) {
  const { projects, projectKey } = useApp();

  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [module, setModule] = useState<Module>('ACTUAL');
  const [reports, setReports] = useState<ReportDefinition[]>([]);
  const [reportId, setReportId] = useState<number | null>(null);

  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [headerRow, setHeaderRow] = useState(0);
  const [dataDate, setDataDate] = useState(today());
  const [period, setPeriod] = useState('');
  const [fileProject, setFileProject] = useState<number | null>(projectKey);
  const [notes, setNotes] = useState('');

  const [targets, setTargets] = useState<TargetField[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [saveMapping, setSaveMapping] = useState(true);

  const [detailKeys, setDetailKeys] = useState<string[]>([]);
  const [staged, setStaged] = useState<StageResult | null>(null);
  const [posted, setPosted] = useState<PostResult | null>(null);

  useEffect(() => {
    call(api.reports.list())
      .then((r) => setReports(r as ReportDefinition[]))
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => { setFileProject(projectKey); }, [projectKey]);

  const moduleReports = reports.filter((r) => r.module === module);
  const selectedReport = reports.find((r) => r.report_definition_id === reportId) ?? null;
  useEffect(() => { setReportId(moduleReports[0]?.report_definition_id ?? null); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [module, reports.length]);

  const sheet: SheetPreview | undefined = useMemo(
    () => preview?.sheets.find((s) => s.sheetName === sheetName),
    [preview, sheetName],
  );

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const pickFile = () => guard(async () => {
    const path = await call(api.files.pick());
    if (!path) return;
    const p = await call(api.files.preview(path)) as FilePreview;
    setPreview(p);
    setSheetName(p.sheets[0]?.sheetName ?? '');
    setHeaderRow(p.sheets[0]?.headerRow ?? 0);
    if (p.detectedDataDate) {
      setDataDate(p.detectedDataDate);
      setPeriod(periodOf(p.detectedDataDate));
    }
    setStaged(null);
    setPosted(null);
    setStep(2);
  });

  const goToMapping = () => guard(async () => {
    if (!sheet) throw new Error('Choose a sheet first.');
    const tf = await call(api.mapping.targets(module)) as TargetField[];
    setTargets(tf);

    // A previously saved profile for this report wins; otherwise auto-suggest.
    const saved = reportId ? await call(api.mapping.load(reportId)) as ColumnMappingEntry[] : [];
    const savedMap: Record<string, string> = {};
    for (const m of saved) {
      if (m.source_column && sheet.columns.includes(m.source_column)) savedMap[m.target_field] = m.source_column;
    }
    const suggested = await call(api.mapping.suggest(module, sheet.columns));
    setMapping({ ...suggested, ...savedMap });

    try {
      const parsed = JSON.parse(selectedReport?.detail_key_fields ?? '[]');
      setDetailKeys(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      setDetailKeys([]);
    }
    setStep(3);
  });

  const stage = () => guard(async () => {
    if (!preview || !sheet || !reportId) throw new Error('Missing file, sheet or source report.');
    const entries: ColumnMappingEntry[] = Object.entries(mapping)
      .filter(([, col]) => !!col)
      .map(([target_field, source_column]) => ({ target_field, source_column }));

    const result = await call(api.imports.stage({
      filePath: preview.filePath,
      fileName: preview.fileName,
      fileHash: preview.fileHash,
      fileSize: preview.fileSize,
      sheetName: sheet.sheetName,
      headerRow,
      module,
      reportDefinitionId: reportId,
      dataDate,
      periodKey: period || null,
      projectKey: fileProject,
      scenarioKey: null,
      notes: notes || null,
      mapping: entries,
      saveMapping,
      detailKeyFields: detailKeys,
    })) as StageResult;
    setStaged(result);
    setStep(4);
  });

  const post = () => guard(async () => {
    if (!staged) return;
    setPosted(await call(api.imports.post(staged.importBatchId)) as PostResult);
    onDone();
  });

  const discard = () => guard(async () => {
    if (staged) await call(api.imports.remove(staged.importBatchId));
    reset();
  });

  const reset = () => {
    setStep(1); setPreview(null); setStaged(null); setPosted(null);
    setMapping({}); setNotes('');
  };

  const missingRequired = targets.filter((t) => t.required && !mapping[t.field]);

  return (
    <>
      <div className="stepper">
        {STEPS.map((s) => (
          <div key={s.n} className={`step ${step === s.n ? 'active' : step > s.n ? 'done' : ''}`}>
            <span className="n">{step > s.n ? '✓' : s.n}</span>
            {s.label}
          </div>
        ))}
      </div>

      {error && <div className="banner err">{error}</div>}

      {/* ---------------- step 1 ---------------- */}
      {step === 1 && (
        <div className="card">
          <h3>What are you loading?</h3>
          <p className="hint">
            Pick the module and the source report. Actual cost comes out of SAP in several
            different extracts — keeping them as separate sources is what lets the app track a
            data date per module.
          </p>

          <div className="row" style={{ marginBottom: 16 }}>
            <label className="field">
              <span>Module</span>
              <select value={module} onChange={(e) => setModule(e.target.value as Module)}>
                {MODULES.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
              </select>
            </label>

            <label className="field" style={{ minWidth: 340 }}>
              <span>Source report</span>
              <select value={reportId ?? ''} onChange={(e) => setReportId(Number(e.target.value))}>
                {moduleReports.map((r) => (
                  <option key={r.report_definition_id} value={r.report_definition_id}>
                    {r.name} ({r.source_system})
                  </option>
                ))}
              </select>
            </label>
          </div>

          {selectedReport?.description && (
            <div className="banner info" style={{ marginBottom: 14 }}>{selectedReport.description}</div>
          )}
          {module === 'SERVICE' && (
            <div className="banner warn" style={{ marginBottom: 14 }}>
              Service lines are a sub-ledger of cost already posted in SAP. They are stored
              separately and reconciled against actuals — loading them here will not change your
              actual cost figures.
            </div>
          )}

          <button className="btn primary" onClick={pickFile} disabled={busy || !reportId}>
            {busy ? <span className="spinner" /> : '↥'} Choose Excel / CSV file…
          </button>
        </div>
      )}

      {/* ---------------- step 2 ---------------- */}
      {step === 2 && preview && (
        <>
          <div className="card">
            <h3>{preview.fileName}</h3>
            <p className="hint">
              {(preview.fileSize / 1024).toFixed(0)} KB · {preview.sheets.length} sheet(s) ·
              sha256 {preview.fileHash.slice(0, 12)}…
            </p>

            <div className="row">
              <label className="field" style={{ minWidth: 220 }}>
                <span>Sheet</span>
                <select value={sheetName} onChange={(e) => {
                  setSheetName(e.target.value);
                  const s = preview.sheets.find((x) => x.sheetName === e.target.value);
                  if (s) setHeaderRow(s.headerRow);
                }}>
                  {preview.sheets.map((s) => (
                    <option key={s.sheetName} value={s.sheetName}>
                      {s.sheetName} ({s.totalRows.toLocaleString()} rows)
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Header row (0-based)</span>
                <input type="number" min={0} value={headerRow} style={{ width: 110 }}
                       onChange={(e) => setHeaderRow(Number(e.target.value))} />
              </label>

              <label className="field">
                <span>Data date (as-of)</span>
                <input type="date" value={dataDate} onChange={(e) => {
                  setDataDate(e.target.value);
                  if (e.target.value) setPeriod(periodOf(e.target.value));
                }} />
              </label>

              <label className="field">
                <span>Period (YYYY-MM)</span>
                <input value={period} placeholder="2026-03" style={{ width: 120 }}
                       onChange={(e) => setPeriod(e.target.value)} />
              </label>

              <label className="field" style={{ minWidth: 240 }}>
                <span>Project (if not a column in the file)</span>
                <select value={fileProject ?? ''} onChange={(e) => setFileProject(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">— taken from the file —</option>
                  {projects.map((p) => (
                    <option key={p.project_key} value={p.project_key}>{p.project_code}</option>
                  ))}
                </select>
              </label>
            </div>

            {preview.detectedDataDate && (
              <div className="banner info" style={{ marginTop: 14 }}>
                Detected <strong>{preview.detectedDataDate}</strong> in the file. Confirm or correct
                it — everything downstream is stamped with this date.
              </div>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              <label className="field" style={{ flex: 1, minWidth: 320 }}>
                <span>Notes (optional)</span>
                <input value={notes} onChange={(e) => setNotes(e.target.value)}
                       placeholder="e.g. re-run after SAP period close" />
              </label>
            </div>
          </div>

          {sheet && (
            <div className="card">
              <h3>Preview</h3>
              <p className="hint">
                First rows as the parser reads them, using row {headerRow} as the header.
              </p>
              <div className="table-wrap" style={{ maxHeight: 300 }}>
                <table>
                  <thead>
                    <tr>{sheet.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {sheet.rows.slice(0, 12).map((r, i) => (
                      <tr key={i}>{sheet.columns.map((c) => (
                        <td key={c}>{r[c] === null || r[c] === undefined ? '—' : String(r[c])}</td>
                      ))}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="row">
            <button className="btn ghost" onClick={reset}>Start over</button>
            <button className="btn primary" onClick={goToMapping} disabled={busy || !sheet || !dataDate}>
              Continue to mapping →
            </button>
          </div>
        </>
      )}

      {/* ---------------- step 3 ---------------- */}
      {step === 3 && sheet && (
        <>
          <div className="card">
            <h3>Map the file onto the warehouse</h3>
            <p className="hint">
              Suggestions are matched from the column captions; correct anything that is wrong.
              Saving the mapping makes the next upload of this report a single click.
            </p>

            {missingRequired.length > 0 && (
              <div className="banner warn">
                Still required: {missingRequired.map((t) => t.label).join(', ')}
              </div>
            )}

            <div className="table-wrap" style={{ maxHeight: 460 }}>
              <table>
                <thead>
                  <tr><th style={{ width: 220 }}>Target field</th><th style={{ width: 280 }}>File column</th><th>Sample</th></tr>
                </thead>
                <tbody>
                  {targets.map((t) => {
                    const col = mapping[t.field] ?? '';
                    const sample = col ? sheet.rows.slice(0, 3).map((r) => r[col]).filter((v) => v != null) : [];
                    return (
                      <tr key={t.field}>
                        <td>
                          {t.label}
                          {t.required && <span style={{ color: 'var(--bad)' }}> *</span>}
                          <div className="faint" style={{ fontSize: 11, whiteSpace: 'normal' }}>{t.description}</div>
                        </td>
                        <td>
                          <select
                            value={col}
                            style={{ width: '100%' }}
                            onChange={(e) => setMapping((m) => ({ ...m, [t.field]: e.target.value }))}
                          >
                            <option value="">— not mapped —</option>
                            {sheet.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td className="faint mono">
                          {sample.length ? sample.map((v) => String(v)).join(' · ') : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <label className="row" style={{ marginTop: 14, gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={saveMapping} style={{ width: 16 }}
                     onChange={(e) => setSaveMapping(e.target.checked)} />
              <span className="muted">Save this mapping as the profile for this source report</span>
            </label>
          </div>

          <div className="row">
            <button className="btn ghost" onClick={() => setStep(2)}>← Back</button>
            <button className="btn primary" onClick={stage} disabled={busy || missingRequired.length > 0}>
              {busy ? <span className="spinner" /> : null} Validate & stage
            </button>
          </div>
        </>
      )}

      {/* ---------------- step 4 ---------------- */}
      {step === 4 && staged && (
        <>
          <div className="grid k4" style={{ marginBottom: 16 }}>
            <div className="kpi">
              <div className="label">Rows read</div>
              <div className="value">{staged.rowCount.toLocaleString()}</div>
            </div>
            <div className="kpi">
              <div className="label">Valid</div>
              <div className="value good">{staged.validCount.toLocaleString()}</div>
            </div>
            <div className="kpi">
              <div className="label">Subtotal rows skipped</div>
              <div className="value">{staged.skippedCount.toLocaleString()}</div>
              <div className="delta">Not data — would double-count</div>
            </div>
            <div className="kpi">
              <div className="label">Rejected</div>
              <div className={`value ${staged.errorCount ? 'bad' : ''}`}>{staged.errorCount.toLocaleString()}</div>
            </div>
          </div>

          <div className="card">
            <h3>Control total</h3>
            <p className="hint">
              This is the sum of the {staged.validCount.toLocaleString()} rows that will post.
              It should equal the grand total printed on the report — if the file carries subtotal
              rows, that only holds once they are excluded, which is what the skip count above is.
            </p>
            <div style={{ fontSize: 26, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {staged.amountTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          {posted ? (
            <div className="banner ok">
              Posted {posted.posted.toLocaleString()} rows into the warehouse as batch
              &nbsp;<strong>#{posted.importBatchId}</strong> with data date {dataDate}.
              Any earlier posting of this report for the same period has been superseded.
            </div>
          ) : (
            <div className="banner info">
              Nothing has reached the fact tables yet. Review the checks below, then post.
            </div>
          )}

          {staged.unresolved.length > 0 && (
            <div className="card">
              <h3>New dimension members</h3>
              <p className="hint">These codes are not in the warehouse yet and will be created on posting.</p>
              {staged.unresolved.map((u) => (
                <div key={u.dimension} style={{ marginBottom: 10 }}>
                  <span className="badge info">{u.dimension}</span>{' '}
                  <span className="faint mono">{u.values.slice(0, 40).join(', ')}
                    {u.values.length > 40 ? ` … +${u.values.length - 40} more` : ''}</span>
                </div>
              ))}
            </div>
          )}

          {staged.issues.length > 0 && (
            <div className="card">
              <h3>Validation issues</h3>
              <p className="hint">Rows with an error are staged but will not be posted.</p>
              <div className="table-wrap" style={{ maxHeight: 280 }}>
                <table>
                  <thead><tr><th className="num">Row</th><th>Severity</th><th>Message</th></tr></thead>
                  <tbody>
                    {staged.issues.map((x, i) => (
                      <tr key={i}>
                        <td className="num">{x.rowNo}</td>
                        <td><span className={`badge ${x.severity === 'ERROR' ? 'bad' : 'warn'}`}>{x.severity}</span></td>
                        <td style={{ whiteSpace: 'normal' }}>{x.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="row">
            {!posted && <button className="btn danger" onClick={discard} disabled={busy}>Discard batch</button>}
            {!posted && (
              <button className="btn primary" onClick={post} disabled={busy || staged.validCount === 0}>
                {busy ? <span className="spinner" /> : null} Post {staged.validCount.toLocaleString()} rows
              </button>
            )}
            {posted && <button className="btn primary" onClick={reset}>Load another file</button>}
          </div>
        </>
      )}
    </>
  );
}
