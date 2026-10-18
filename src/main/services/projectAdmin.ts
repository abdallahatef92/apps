import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { currentDbPath, getDb } from '../db';

/**
 * Removing a project's data, or the project itself.
 *
 * Every fact table carries project_key, so a project's lines are removed by project, not by file:
 * one CJI3 export can hold several projects, and only this project's lines go. A file (import_batch)
 * is removed once no fact line of any project is left on it; a file that still carries another
 * project's lines stays. A material list (MATLIST) writes dim_material only — it has no lines and
 * no project, is shared, and is never touched here.
 *
 * A copy of the database is written first (backups/ beside it), so either action can be undone by
 * opening that copy.
 */

const FACT_TABLES = [
  'fact_actual', 'fact_budget', 'fact_forecast', 'fact_service_line', 'service_line_snapshot',
  'fact_po_service_line', 'fact_order_line', 'fact_accrual', 'fact_material_issue', 'fact_po_material_line',
];

/** Coding and settings that belong to one project (kept by "remove data", removed with the project). */
const PROJECT_SETTINGS_TABLES = [
  'project_cutoff', 'material_work_package', 'cost_element_work_package', 'service_work_package',
  'service_mnl', 'dim_tow_order', 'value_mapping', 'dim_scenario',
];

export interface ProjectRemovalResult {
  backupPath: string;
  lines: number;          // fact lines removed
  files: number;          // import batches removed
}

function backupFirst(tag: string, projectCode: string): string {
  const db = getDb();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const src = currentDbPath();
  const dir = join(dirname(src), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = projectCode.replace(/[^A-Za-z0-9_-]+/g, '_');
  const dest = join(dir, `${basename(src, '.db')}.before-${tag}-${safe}-${stamp}.db`);
  copyFileSync(src, dest);
  return dest;
}

function projectCode(projectKey: number): string {
  const row = getDb().prepare('SELECT project_code FROM dim_project WHERE project_key = ?').get(projectKey) as
    { project_code: string } | undefined;
  if (!row) throw new Error('That project no longer exists.');
  return row.project_code;
}

/** Fact lines, files and WBS of the project. Must run inside a transaction. */
function removeData(projectKey: number): { lines: number; files: number } {
  const db = getDb();
  const batches = (db.prepare(`
    SELECT import_batch_id FROM v_project_batch WHERE project_key = ?
    UNION SELECT import_batch_id FROM import_batch WHERE project_key = ? AND module <> 'MATLIST'`)
    .all(projectKey, projectKey) as { import_batch_id: number }[]).map((r) => r.import_batch_id);

  let lines = 0;
  for (const t of FACT_TABLES) lines += db.prepare(`DELETE FROM ${t} WHERE project_key = ?`).run(projectKey).changes;

  const stillUsed = db.prepare(FACT_TABLES.map((t) => `SELECT 1 FROM ${t} WHERE import_batch_id = @id`).join(' UNION ALL ') + ' LIMIT 1');
  let files = 0;
  for (const id of batches) {
    if (stillUsed.get({ id })) continue;
    const mod = db.prepare('SELECT module FROM import_batch WHERE import_batch_id = ?').get(id) as { module: string } | undefined;
    if (!mod || mod.module === 'MATLIST') continue;
    db.prepare('DELETE FROM stg_row WHERE import_batch_id = ?').run(id);
    db.prepare(`UPDATE import_batch SET status = 'POSTED', superseded_by = NULL
                WHERE superseded_by = ? AND status = 'SUPERSEDED'`).run(id);
    db.prepare('UPDATE import_batch SET superseded_by = NULL WHERE superseded_by = ?').run(id);
    files += db.prepare('DELETE FROM import_batch WHERE import_batch_id = ?').run(id).changes;
  }
  // WBS: children before parents is not needed — one statement removes the whole tree at once
  db.prepare('DELETE FROM dim_wbs WHERE project_key = ?').run(projectKey);
  return { lines, files };
}

/** Remove every uploaded line and file of the project; keep the project, its cut-off and its coding. */
export function clearProjectData(projectKey: number): ProjectRemovalResult {
  const backupPath = backupFirst('clear-project', projectCode(projectKey));
  const db = getDb();
  const r = db.transaction(() => removeData(projectKey))();
  return { backupPath, ...r };
}

/** Remove the project with all its data, coding and settings. */
export function deleteProject(projectKey: number): ProjectRemovalResult {
  const backupPath = backupFirst('delete-project', projectCode(projectKey));
  const db = getDb();
  const r = db.transaction(() => {
    const out = removeData(projectKey);
    for (const t of PROJECT_SETTINGS_TABLES) db.prepare(`DELETE FROM ${t} WHERE project_key = ?`).run(projectKey);
    // a file that still carries another project's lines (or a shared material list) stays, without this project
    db.prepare('UPDATE import_batch SET project_key = NULL WHERE project_key = ?').run(projectKey);
    db.prepare('DELETE FROM dim_project WHERE project_key = ?').run(projectKey);
    return out;
  })();
  return { backupPath, ...r };
}

/** What a removal would touch — shown in the confirmation before anything is deleted. */
export function projectFootprint(projectKey: number): { lines: number; files: number } {
  const db = getDb();
  let lines = 0;
  for (const t of FACT_TABLES) {
    lines += (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_key = ?`).get(projectKey) as { n: number }).n;
  }
  const files = (db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT import_batch_id FROM v_project_batch WHERE project_key = ?
      UNION SELECT import_batch_id FROM import_batch WHERE project_key = ? AND module <> 'MATLIST')`)
    .get(projectKey, projectKey) as { n: number }).n;
  return { lines, files };
}
