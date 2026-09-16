import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { closeDatabase, currentDbPath, defaultDbPath, getDb, openDatabase } from './db';
import { runSelect, runStoredQuery } from './services/queryRunner';
import { exportCostTypeMapping, exportResult } from './services/exportExcel';
import { buildPivotSql, pivotMeta, type PivotRequest } from './services/pivot';
import { readWorkbook } from './ingest/workbook';
import { deleteBatch, loadColumnMapping, postBatch, revenueAccountPattern, saveColumnMapping, stageFile } from './ingest/importer';
import { suggestMapping, targetFields } from './ingest/targetFields';
import { COST_TYPE_VALUES } from '../shared/types';
import type { CostTypeAssignment, CostTypeCombination, CostTypeRuleInput, IpcResult, Module, QueryResult, StageRequest } from '../shared/types';

/** Wrap a handler so the renderer always gets {ok,data} | {ok,error} instead of a rejection. */
function handle<T>(channel: string, fn: (...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_e, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err);
      return { ok: false, error: (err as Error).message ?? String(err) };
    }
  });
}

/** Shared by the combinations list and its Excel export, so the two never drift apart. */
function loadCostTypeCombinations(): CostTypeCombination[] {
  return getDb().prepare(`
    SELECT a.cost_element_code, a.cost_element_name,
           COALESCE(a.document_type,'') AS document_type,
           COUNT(*) AS postings, SUM(a.amount) AS amount,
           a.cost_type AS resolved_cost_type,
           (SELECT r.cost_type FROM cost_type_rule r
             WHERE r.is_active = 1
               AND r.cost_element_glob = a.cost_element_code
               AND r.document_type_glob = COALESCE(a.document_type,'')
             ORDER BY r.priority, r.rule_id LIMIT 1) AS assigned_cost_type
    FROM v_actual a
    GROUP BY a.cost_element_code, a.cost_element_name,
             COALESCE(a.document_type,''), a.cost_type
    ORDER BY ABS(SUM(a.amount)) DESC`).all() as CostTypeCombination[];
}

export function registerIpc(): void {
  // --- app / database ------------------------------------------------------
  handle('app:info', () => ({
    version: __APP_VERSION__,
    dbPath: currentDbPath(),
    userData: app.getPath('userData'),
  }));

  handle('db:open', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open cost database',
      defaultPath: defaultDbPath(),
      filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { changed: false, dbPath: currentDbPath() };
    openDatabase(res.filePaths[0]);
    return { changed: true, dbPath: currentDbPath() };
  });

  handle('db:backup', async () => {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const res = await dialog.showSaveDialog({
      title: 'Back up database',
      defaultPath: join(app.getPath('documents'), `cost-intelligence-${stamp}.db`),
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    });
    if (res.canceled || !res.filePath) return null;
    getDb().pragma('wal_checkpoint(TRUNCATE)');
    copyFileSync(currentDbPath(), res.filePath);
    return res.filePath;
  });

  // --- master data ---------------------------------------------------------
  handle('projects:list', () =>
    getDb().prepare(`SELECT p.*, c.iso_code AS currency_code
                     FROM dim_project p LEFT JOIN dim_currency c ON c.currency_key = p.currency_key
                     ORDER BY p.project_code`).all());

  handle('projects:create', (p: { project_code: string; project_name: string; client_name?: string;
                                  currency_code?: string; contract_value?: number }) => {
    const db = getDb();
    const cur = p.currency_code
      ? (db.prepare('SELECT currency_key FROM dim_currency WHERE iso_code = ?').get(p.currency_code) as any)
      : null;
    const info = db.prepare(`INSERT INTO dim_project
      (project_code, project_name, client_name, currency_key, contract_value)
      VALUES (?,?,?,?,?)`)
      .run(p.project_code.trim(), p.project_name.trim(), p.client_name ?? null,
        cur?.currency_key ?? null, p.contract_value ?? null);
    return { project_key: Number(info.lastInsertRowid) };
  });

  handle('settings:list', () =>
    getDb().prepare('SELECT key, value FROM app_setting ORDER BY key').all());

  handle('settings:set', (key: string, value: string) => {
    getDb().prepare(`INSERT INTO app_setting (key, value) VALUES (?,?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                                    updated_at = datetime('now')`)
      .run(key, value);
  });

  /**
   * Re-apply the cost/revenue rule to cost elements already in the warehouse, so
   * changing the pattern fixes history instead of only affecting the next import.
   */
  handle('settings:reclassify', () => {
    const db = getDb();
    const pattern = revenueAccountPattern();
    const rows = db.prepare('SELECT cost_element_key, cost_element_code FROM dim_cost_element')
      .all() as { cost_element_key: number; cost_element_code: string }[];
    const upd = db.prepare('UPDATE dim_cost_element SET posting_nature = ? WHERE cost_element_key = ?');
    let changed = 0;
    const run = db.transaction(() => {
      for (const r of rows) {
        const nature = pattern.test(r.cost_element_code) ? 'REVENUE' : 'COST';
        changed += upd.run(nature, r.cost_element_key).changes;
      }
    });
    run();
    return { costElements: rows.length, updated: changed };
  });

  /**
   * Cost type rules.
   *
   * Unlike the revenue pattern there is no "apply to history" step: the rules are
   * read by v_posting when a report runs, so a save is visible everywhere at once.
   */
  handle('costTypes:list', () =>
    getDb().prepare(`SELECT rule_id, priority, cost_element_glob, document_type_glob,
                            cost_type, note, is_active
                     FROM cost_type_rule ORDER BY priority, rule_id`).all());

  handle('costTypes:save', (rules: CostTypeRuleInput[]) => {
    const db = getDb();
    for (const r of rules) {
      if (!COST_TYPE_VALUES.includes(r.cost_type)) {
        throw new Error(`"${r.cost_type}" is not a cost type. Expected one of ${COST_TYPE_VALUES.join(', ')}.`);
      }
      if (!r.cost_element_glob && !r.document_type_glob) {
        throw new Error('A rule needs a cost element pattern, a document type pattern, or both — '
          + 'one matching everything would mask every rule below it.');
      }
    }
    const run = db.transaction(() => {
      db.prepare('DELETE FROM cost_type_rule').run();
      const ins = db.prepare(`INSERT INTO cost_type_rule
        (rule_id, priority, cost_element_glob, document_type_glob, cost_type, note, is_active)
        VALUES (?,?,?,?,?,?,?)`);
      rules.forEach((r, i) => ins.run(
        r.rule_id ?? null,
        r.priority ?? (i + 1) * 10,
        r.cost_element_glob?.trim() || null,
        r.document_type_glob?.trim() || null,
        r.cost_type,
        r.note?.trim() || null,
        r.is_active === 0 ? 0 : 1));
    });
    run();
    return { rules: rules.length };
  });

  /**
   * What the current rules actually produce, so the effect of an edit is visible
   * before it is trusted. UNMAPPED is the number that matters: it means the chart
   * of accounts does not match the rules and a breakdown will collapse to one bar.
   */
  handle('costTypes:preview', () =>
    getDb().prepare(`SELECT COALESCE(cost_type,'UNMAPPED') AS cost_type,
                            COUNT(*) AS postings, COALESCE(SUM(amount),0) AS amount
                     FROM v_actual
                     GROUP BY COALESCE(cost_type,'UNMAPPED')
                     ORDER BY amount DESC`).all());

  /**
   * Every (cost element, document type) pair that actually occurs in posted cost.
   *
   * Derived from the data, not typed in, so the list is exactly what needs an
   * answer. `assigned_cost_type` is filled only when a rule names the pair
   * outright — anything else is inherited from a pattern and shown as such, so
   * the user can see which answers they have given and which were guessed.
   */
  handle('costTypes:combinations', () => loadCostTypeCombinations());

  handle('costTypes:exportMapping', async () => {
    const res = await dialog.showSaveDialog({
      title: 'Export cost type mapping',
      defaultPath: join(app.getPath('documents'), `Cost type mapping ${new Date().toISOString().slice(0, 10)}.xlsx`),
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await exportCostTypeMapping(res.filePath, loadCostTypeCombinations());
    return res.filePath;
  });

  /**
   * Allocate a cost type to named pairs.
   *
   * Written as ordinary rules, so an allocation and a pattern are the same kind
   * of thing and the rules table stays the single answer to "why is this line a
   * subcontract?". They are exact — no wildcard — and sit at priority 1 so they
   * always beat the account ranges. Two of them can never disagree, because a
   * pair occurs once.
   */
  handle('costTypes:assign', (items: CostTypeAssignment[]) => {
    const db = getDb();
    for (const it of items) {
      if (it.cost_type !== null && !COST_TYPE_VALUES.includes(it.cost_type)) {
        throw new Error(`"${it.cost_type}" is not a cost type.`);
      }
      // A code or document type carrying a GLOB metacharacter would silently
      // become a wildcard and capture pairs the user never looked at.
      for (const v of [it.cost_element_code, it.document_type]) {
        if (/[*?[\]]/.test(v)) throw new Error(`"${v}" contains a wildcard character and cannot be allocated directly.`);
      }
    }
    const del = db.prepare(`DELETE FROM cost_type_rule
                            WHERE cost_element_glob = ? AND document_type_glob = ?`);
    const ins = db.prepare(`INSERT INTO cost_type_rule
      (priority, cost_element_glob, document_type_glob, cost_type, note)
      VALUES (1, ?, ?, ?, ?)`);
    let assigned = 0, cleared = 0;
    const run = db.transaction(() => {
      for (const it of items) {
        del.run(it.cost_element_code, it.document_type);
        if (it.cost_type === null) { cleared++; continue; }
        ins.run(it.cost_element_code, it.document_type, it.cost_type,
          `Allocated for document type ${it.document_type || '(none)'}`);
        assigned++;
      }
    });
    run();
    return { assigned, cleared };
  });

  handle('reports:list', () =>
    getDb().prepare(`SELECT rd.*, ss.code AS source_system
                     FROM report_definition rd
                     JOIN source_system ss ON ss.source_system_id = rd.source_system_id
                     WHERE rd.is_active = 1 ORDER BY rd.module, rd.name`).all());

  handle('freshness:list', () =>
    getDb().prepare('SELECT * FROM v_data_freshness ORDER BY module, report_name').all());

  handle('batches:list', (limit = 200) =>
    getDb().prepare(`SELECT b.*, rd.name AS report_name
                     FROM import_batch b
                     JOIN report_definition rd ON rd.report_definition_id = b.report_definition_id
                     ORDER BY b.imported_at DESC LIMIT ?`).all(limit));

  // --- upload flow ---------------------------------------------------------
  handle('file:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Select a cost report',
      filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'csv'] }],
      properties: ['openFile'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  handle('file:preview', (filePath: string) => readWorkbook(filePath));

  handle('mapping:targets', (module: Module) => targetFields(module));
  handle('mapping:suggest', (module: Module, columns: string[]) => suggestMapping(module, columns));
  handle('mapping:load', (reportDefinitionId: number) => loadColumnMapping(reportDefinitionId));
  handle('mapping:save', (reportDefinitionId: number, mapping: any[]) =>
    saveColumnMapping(reportDefinitionId, mapping));

  handle('import:stage', (req: StageRequest) => stageFile(req, process.env.USERNAME ?? process.env.USER ?? null));
  handle('import:post', (batchId: number, allowDuplicate = false) =>
    postBatch(batchId, { allowDuplicate }));
  handle('import:delete', (batchId: number) => deleteBatch(batchId));
  handle('import:issues', (batchId: number, limit = 200) =>
    getDb().prepare(`SELECT row_no, status, message, raw_json FROM stg_row
                     WHERE import_batch_id = ? AND status IN ('ERROR','WARN')
                     ORDER BY row_no LIMIT ?`).all(batchId, limit));

  // --- query library -------------------------------------------------------
  handle('query:list', () =>
    getDb().prepare('SELECT * FROM query_library WHERE is_active = 1 ORDER BY module, category, name').all());

  handle('query:run', (code: string, params: Record<string, unknown>) => runStoredQuery(code, params ?? {}));
  handle('query:runSql', (sql: string, params: Record<string, unknown>) => runSelect(sql, params ?? {}));

  handle('query:save', (q: { query_id?: number; code: string; name: string; module: string;
                             category?: string; description?: string; sql_text: string; params_json?: string }) => {
    const db = getDb();
    if (q.query_id) {
      db.prepare(`UPDATE query_library
                  SET name=?, module=?, category=?, description=?, sql_text=?, params_json=?,
                      updated_at=datetime('now')
                  WHERE query_id=? AND is_system=0`)
        .run(q.name, q.module, q.category ?? null, q.description ?? null, q.sql_text,
          q.params_json ?? '[]', q.query_id);
      return { query_id: q.query_id };
    }
    const info = db.prepare(`INSERT INTO query_library
      (code, name, module, category, description, sql_text, params_json, is_system)
      VALUES (?,?,?,?,?,?,?,0)`)
      .run(q.code, q.name, q.module, q.category ?? null, q.description ?? null,
        q.sql_text, q.params_json ?? '[]');
    return { query_id: Number(info.lastInsertRowid) };
  });

  handle('query:delete', (queryId: number) =>
    getDb().prepare('DELETE FROM query_library WHERE query_id = ? AND is_system = 0').run(queryId).changes);

  // --- pivot ---------------------------------------------------------------
  handle('pivot:meta', () => pivotMeta());
  handle('pivot:build', (req: PivotRequest) => buildPivotSql(req));

  // --- export --------------------------------------------------------------
  handle('export:result', async (result: QueryResult, meta: { title: string; subtitle?: string;
                                                              context?: Record<string, unknown> }) => {
    const safe = meta.title.replace(/[^\w \-]/g, '').trim() || 'export';
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog({
      title: 'Export to Excel',
      defaultPath: join(app.getPath('documents'), `${safe} ${stamp}.xlsx`),
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await exportResult(res.filePath, result, meta);
    return res.filePath;
  });

  handle('shell:showItem', (filePath: string) => { shell.showItemInFolder(filePath); });

  handle('window:reloadData', () => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('data:changed'));
  });
}

export function disposeIpc(): void {
  closeDatabase();
}
