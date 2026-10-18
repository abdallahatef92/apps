import type { PostResult, StageResult } from '@shared/types';

/**
 * What staging found, before anything posts: row counts, the control total,
 * whether lines will merge or add, new dimension members and rejected rows.
 * Shared by file upload and the live SAP pull, because both stage the same way
 * and the user must be able to judge either before posting.
 */
export function StageReview({ staged, posted, dataDate, allowDuplicate, onAllowDuplicate }: {
  staged: StageResult;
  posted: PostResult | null;
  dataDate: string;
  allowDuplicate: boolean;
  onAllowDuplicate: (v: boolean) => void;
}) {
  return (
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

      {!posted && (
        <div className={`banner ${staged.lineKey.usable ? 'info' : 'warn'}`}>
          <div>
            {staged.lineKey.usable ? (
              <>
                <strong>Each row is identified by {staged.lineKey.used.join(' + ')}.</strong>{' '}
                {staged.lineKey.willReplace > 0
                  ? <>{staged.lineKey.willReplace.toLocaleString()} of these lines are already in
                      the warehouse and will be updated in place; the remaining
                      &nbsp;{(staged.validCount - staged.lineKey.willReplace).toLocaleString()} are new.
                      Overlapping extracts merge, so nothing is counted twice.</>
                  : <>None of these lines are in the warehouse yet, so all
                      &nbsp;{staged.validCount.toLocaleString()} are new. Re-importing an
                      overlapping extract later will update them rather than add to them.</>}
              </>
            ) : (
              <>
                <strong>No usable line identity in this file.</strong>{' '}
                {staged.lineKey.duplicatesInFile > 0
                  ? <>{staged.lineKey.used.join(' + ')} repeats on
                      &nbsp;{staged.lineKey.duplicatesInFile.toLocaleString()} row(s), so it cannot
                      tell one posting from another.</>
                  : <>Nothing identifies an individual row.</>}
                {staged.lineKey.expected.length > 0 && (
                  <> Map {staged.lineKey.expected.join(', ')} to let re-imports merge instead of
                    adding. Without it, a later overlapping extract can only replace this whole
                    import, not merge with it.</>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!posted && staged.duplicateOf && !staged.lineKey.usable && (
        <div className="banner err">
          <div>
            <strong>This file has already been imported.</strong> Batch
            &nbsp;#{staged.duplicateOf.importBatchId} ({staged.duplicateOf.fileName}, data date
            &nbsp;{staged.duplicateOf.dataDate}) has byte-for-byte identical content and is
            &nbsp;{staged.duplicateOf.status}. With no line identity to merge on, posting it
            again would count the same cost twice.
            <div style={{ marginTop: 8 }}>
              <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={allowDuplicate} style={{ width: 16 }}
                       onChange={(e) => onAllowDuplicate(e.target.checked)} />
                <span>Post it anyway — I know this is a duplicate</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {!posted && staged.duplicateOf && staged.lineKey.usable && (
        <div className="banner info">
          The same file was imported before as batch #{staged.duplicateOf.importBatchId}.
          Because every row carries a line identity, posting it again rewrites those same lines
          rather than adding to them.
        </div>
      )}

      {posted ? (
        <div className="banner ok">
          Posted {posted.posted.toLocaleString()} rows as batch
          &nbsp;<strong>#{posted.importBatchId}</strong> with data date {dataDate}
          {posted.byLineKey
            ? <> — {posted.replaced.toLocaleString()} updated an existing line and
                &nbsp;{(posted.posted - posted.replaced).toLocaleString()} were new.</>
            : <>. This source has no line identity, so any earlier posting of the same report
                and period was superseded wholesale.</>}
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
    </>
  );
}
