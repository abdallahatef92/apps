import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { today } from '../lib/format';
import { StageReview } from '../components/StageReview';
import { DEFAULT_EXTRACT, buildFilter } from '@shared/sapFilter';
import type { PostResult, SapConnection, SapExtract, SapPullResult } from '@shared/types';

/** First day of the month, `months` months back — the default overlap of a refresh. */
function monthsBack(months: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * Log on to S/4HANA and pull actual cost in one click — opened from the CJI3 card on Home, as the
 * alternative to uploading a CJI3 file (ported from branch ccr-ef4884cd-jzod7f).
 *
 * The pull stages like an upload and is reviewed like one; posting is still a separate, deliberate step.
 * Re-pulling an overlapping range is safe because every journal line carries its own identity and merges
 * onto itself. Posting is blocked while the project has cost from another actual source (CJI3): FI and CO
 * document numbers never match, so both would count.
 */
export function SapConnect({ onDone, onClose }: { onDone: () => void; onClose?: () => void }) {
  const { projects, projectKey } = useApp();

  const [conn, setConn] = useState<SapConnection>({ baseUrl: '', client: '', user: '', language: 'EN' });
  const [extract, setExtract] = useState<SapExtract>(DEFAULT_EXTRACT);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [canRemember, setCanRemember] = useState(false);

  const [target, setTarget] = useState<number | null>(projectKey);
  const [dataDate, setDataDate] = useState(today());

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<{ columns: string[] } | null>(null);
  const [pulled, setPulled] = useState<SapPullResult | null>(null);
  const [posted, setPosted] = useState<PostResult | null>(null);
  const [allowDuplicate, setAllowDuplicate] = useState(false);

  useEffect(() => {
    call(api.sap.config()).then((c) => {
      setConn(c.connection);
      setExtract({ ...c.extract, postedFrom: c.extract.postedFrom ?? monthsBack(3) });
      setHasSaved(c.hasSavedPassword);
      setCanRemember(c.canRememberPassword);
    }).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => { setTarget(projectKey); }, [projectKey]);

  const project = projects.find((p) => p.project_key === target) ?? null;
  // The WBS prefix defaults to the project code, which is how SAP numbers its WBS.
  const effective = useMemo<SapExtract>(
    () => ({ ...extract, wbsPrefix: extract.wbsPrefix || project?.project_code || '' }),
    [extract, project],
  );
  const filter = buildFilter(effective);

  const loggedInReady = !!conn.baseUrl.trim() && !!conn.user.trim() && (!!password || hasSaved);

  const guard = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const test = () => guard('test', async () => {
    // The raw extract is what gets saved, so a blank prefix stays blank and keeps
    // following whichever project is chosen next time.
    const r = await call(api.sap.test({ connection: conn, extract,
      password: password || undefined, rememberPassword: remember }));
    setTested({ columns: r.columns });
    if (remember && password) setHasSaved(true);
  });

  const pull = () => guard('pull', async () => {
    if (!target) throw new Error('Choose the project this cost belongs to.');
    setPulled(null);
    setPosted(null);
    setAllowDuplicate(false);
    const r = await call(api.sap.pull({
      connection: conn, extract, password: password || undefined,
      rememberPassword: remember, projectKey: target, dataDate,
    }));
    setPulled(r);
    if (remember && password) setHasSaved(true);
  });

  const post = () => guard('post', async () => {
    if (!pulled) return;
    setPosted(await call(api.imports.post(pulled.stage.importBatchId, allowDuplicate)) as PostResult);
    onDone();
  });

  const discard = () => guard('discard', async () => {
    if (pulled) await call(api.imports.remove(pulled.stage.importBatchId));
    setPulled(null);
  });

  const forget = () => guard('forget', async () => {
    await call(api.sap.forgetPassword());
    setHasSaved(false);
    setRemember(false);
  });

  const setC = (k: keyof SapConnection) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setConn((c) => ({ ...c, [k]: e.target.value }));
  const setX = (k: keyof SapExtract) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setExtract((x) => ({ ...x, [k]: e.target.value || (k === 'postedFrom' ? null : '') }));

  const staged = pulled?.stage ?? null;

  const blocked = (pulled?.otherActualSources.length ?? 0) > 0;

  return (
    <>
      <div className="upload-head">
        <div><span className="faint">Load into</span> <strong>B04 · Actual cost</strong> <span className="faint">— live from S/4HANA</span></div>
        {onClose && <button className="btn sm" onClick={onClose}>← Back to the map</button>}
      </div>
      {error && <div className="banner err">{error}</div>}

      <div className="grid k2" style={{ marginBottom: 16 }}>
        <div className="card">
          <h3>Log on</h3>
          <p className="hint">
            Your own SAP user, over HTTPS. Nothing to install: S/4HANA only needs the journal
            entry API activated and your role allowed to read it.
          </p>

          <div className="row" style={{ marginBottom: 12 }}>
            <label className="field" style={{ flex: 1, minWidth: 280 }}>
              <span>System URL</span>
              <input value={conn.baseUrl} onChange={setC('baseUrl')} placeholder="https://10.10.20.16:44300" />
              <span className="faint" style={{ fontSize: 11, marginTop: 3 }}>
                From SAP GUI: the application server, then HTTPS port 443 + instance number (instance 00 → :44300).
              </span>
            </label>
            <label className="field">
              <span>Client</span>
              <input value={conn.client} onChange={setC('client')} placeholder="100" style={{ width: 80 }} />
            </label>
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <label className="field" style={{ flex: 1 }}>
              <span>User</span>
              <input value={conn.user} onChange={setC('user')} autoComplete="username" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Password</span>
              <input type="password" value={password} autoComplete="current-password"
                     placeholder={hasSaved ? 'saved on this computer' : ''}
                     onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span>Language</span>
              <input value={conn.language} onChange={setC('language')} style={{ width: 60 }} />
            </label>
          </div>

          <div className="row" style={{ alignItems: 'center' }}>
            {canRemember && (
              <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={remember} style={{ width: 16 }}
                       onChange={(e) => setRemember(e.target.checked)} />
                <span className="muted">Remember password on this computer</span>
              </label>
            )}
            {hasSaved && <button className="btn ghost sm" onClick={forget} disabled={!!busy}>Forget saved password</button>}
            <div style={{ flex: 1 }} />
            <button className="btn" onClick={test} disabled={!!busy || !loggedInReady}>
              {busy === 'test' ? <span className="spinner" /> : null} Test connection
            </button>
          </div>

          {tested && (
            <div className="banner ok" style={{ marginTop: 14 }}>
              <div>
                Connected. The service sends {tested.columns.length} fields
                {tested.columns.length > 0 && (
                  <div className="faint mono" style={{ marginTop: 6, whiteSpace: 'normal' }}>
                    {tested.columns.join(', ')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <h3>What to pull</h3>
          <p className="hint">
            Posted cost on the project's WBS since the date below. Pulling an overlapping range
            again is safe — each journal line merges onto itself, so nothing is counted twice.
          </p>

          <div className="row" style={{ marginBottom: 12 }}>
            <label className="field" style={{ minWidth: 220 }}>
              <span>Project</span>
              <select value={target ?? ''} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— choose —</option>
                {projects.map((p) => <option key={p.project_key} value={p.project_key}>{p.project_code}</option>)}
              </select>
            </label>
            <label className="field">
              <span>WBS starts with</span>
              <input value={extract.wbsPrefix} onChange={setX('wbsPrefix')}
                     placeholder={project?.project_code ?? ''} style={{ width: 150 }} />
            </label>
            <label className="field">
              <span>Posted from</span>
              <input type="date" value={extract.postedFrom ?? ''} onChange={setX('postedFrom')} />
            </label>
            <label className="field">
              <span>Data date (as-of)</span>
              <input type="date" value={dataDate} onChange={(e) => setDataDate(e.target.value)} />
            </label>
          </div>

          <details style={{ marginBottom: 12 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>Advanced — service and fields</summary>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="field" style={{ flex: 1, minWidth: 300 }}>
                <span>Service path</span>
                <input value={extract.servicePath} onChange={setX('servicePath')} />
              </label>
              <label className="field">
                <span>Entity set</span>
                <input value={extract.entitySet} onChange={setX('entitySet')} />
              </label>
              <label className="field">
                <span>WBS field</span>
                <input value={extract.wbsField} onChange={setX('wbsField')} style={{ width: 130 }} />
              </label>
              <label className="field">
                <span>Date field</span>
                <input value={extract.dateField} onChange={setX('dateField')} style={{ width: 130 }} />
              </label>
              <label className="field" style={{ flex: 1, minWidth: 300 }}>
                <span>Extra filter</span>
                <input value={extract.extraFilter} onChange={setX('extraFilter')} />
              </label>
            </div>
          </details>

          <div className="faint mono" style={{ whiteSpace: 'normal', marginBottom: 14 }}>
            $filter={filter || '(none)'}
          </div>

          <button className="btn primary" onClick={pull} disabled={!!busy || !loggedInReady || !target || !dataDate}>
            {busy === 'pull' ? <span className="spinner" /> : '⟳'} Refresh from SAP
          </button>
        </div>
      </div>

      {pulled && staged && (
        <>
          {pulled.otherActualSources.length > 0 && !posted && (
            <div className="banner err">
              <div>
                <strong>This project already has actual cost from another source:</strong>{' '}
                {pulled.otherActualSources.map((s) => `${s.report_name} (${s.postings.toLocaleString()} postings)`).join(', ')}.
                SAP numbers journal entries and CO documents differently, so these lines will not
                merge with that cost — posting both counts it twice. Remove those files in Loaded files
                first, or keep using that source for this project. Posting is blocked until then.
              </div>
            </div>
          )}
          {pulled.missingColumns.length > 0 && (
            <div className="banner warn">
              SAP did not send {pulled.missingColumns.join(', ')}. Those fields stay empty on these
              lines — if one was renamed in your system, the mapping for this source needs it.
            </div>
          )}
          {staged.rowCount === 0 && (
            <div className="banner warn">
              Nothing matched the filter. Check the WBS prefix and the date — SAP returned no rows.
            </div>
          )}

          <StageReview staged={staged} posted={posted} dataDate={dataDate}
                       allowDuplicate={allowDuplicate} onAllowDuplicate={setAllowDuplicate} />

          <div className="row">
            {!posted && <button className="btn danger" onClick={discard} disabled={!!busy}>Discard pull</button>}
            {!posted && (
              <button
                className="btn primary"
                onClick={post}
                disabled={!!busy || blocked || staged.validCount === 0
                  || (!!staged.duplicateOf && !staged.lineKey.usable && !allowDuplicate)}
              >
                {busy === 'post' ? <span className="spinner" /> : null} Post {staged.validCount.toLocaleString()} rows
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
