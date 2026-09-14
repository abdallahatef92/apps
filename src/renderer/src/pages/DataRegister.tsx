import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../App';
import { api, call } from '../lib/api';
import { money } from '../lib/format';
import type { BatchRow } from '@shared/types';

const STATUS_BADGE: Record<string, string> = {
  POSTED: 'good', MAPPED: 'info', STAGED: 'info', SUPERSEDED: 'mute', REJECTED: 'bad',
};

/** The audit trail: every file that was ever loaded, with its as-of date. */
export function DataRegister() {
  const { touch, dataVersion } = useApp();
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try { setRows(await call(api.batches.list(300)) as BatchRow[]); }
    catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { load(); }, [load, dataVersion]);

  const post = async (id: number) => {
    setBusy(id); setError(null);
    try { await call(api.imports.post(id)); await load(); touch(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const remove = async (id: number, posted: boolean) => {
    if (posted && !window.confirm(
      `Delete batch #${id}?\n\nIts rows are removed from the warehouse. Anything this batch ` +
      'superseded goes back to being the live position. This cannot be undone.')) return;
    setBusy(id); setError(null);
    try { await call(api.imports.remove(id)); await load(); touch(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <>
      {error && <div className="banner err">{error}</div>}

      <div className="card">
        <h3>Import register</h3>
        <p className="hint">
          Superseded batches stay in the database — their rows are simply excluded from reporting,
          so an old position can always be explained. "Skipped" counts subtotal rows the parser
          recognised in the source report and deliberately left out. Deleting a batch removes its
          rows and restores whatever it superseded.
        </p>

        <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 270px)' }}>
          <table>
            <thead>
              <tr>
                <th className="num">#</th><th>Source report</th><th>Module</th>
                <th>Data date</th><th>Period</th><th>File</th>
                <th className="num">Rows</th><th className="num">Skipped</th><th className="num">Rejected</th>
                <th className="num">Control total</th><th>Status</th><th>Imported</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={13}><div className="empty">Nothing imported yet.</div></td></tr>
              )}
              {rows.map((b) => (
                <tr key={b.import_batch_id}>
                  <td className="num">{b.import_batch_id}</td>
                  <td>{b.report_name}</td>
                  <td><span className="badge mute">{b.module}</span></td>
                  <td className="mono">{b.data_date}</td>
                  <td className="mono">{b.period_key ?? '—'}</td>
                  <td title={b.file_name} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {b.file_name}
                  </td>
                  <td className="num">{(b.row_count_posted || b.row_count_file).toLocaleString()}</td>
                  <td className="num faint">{b.row_count_skipped || '—'}</td>
                  <td className="num">{b.row_count_rejected || '—'}</td>
                  <td className="num">{money(b.amount_total)}</td>
                  <td><span className={`badge ${STATUS_BADGE[b.status] ?? 'mute'}`}>{b.status}</span></td>
                  <td className="faint">{b.imported_at?.slice(0, 16)}</td>
                  <td className="nowrap">
                    {b.status === 'MAPPED' && (
                      <button className="btn sm" disabled={busy === b.import_batch_id}
                              onClick={() => post(b.import_batch_id)}>Post</button>
                    )}
                    <button className="btn sm danger" style={{ marginLeft: 6 }}
                            disabled={busy === b.import_batch_id}
                            onClick={() => remove(b.import_batch_id, b.status === 'POSTED')}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
