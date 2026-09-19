import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { closeDatabase, currentDbPath, defaultDbPath, getDb, openDatabase } from './db';
import { runSelect, runStoredQuery } from './services/queryRunner';
import { exportCostTypeMapping, exportResult } from './services/exportExcel';
import { buildPivotSql, pivotMeta, type PivotRequest } from './services/pivot';
import { buildLineage } from './services/lineage';
import { readWorkbook } from './ingest/workbook';
import { deleteBatch, loadColumnMapping, postBatch, revenueAccountPattern, saveColumnMapping, stageFile } from './ingest/importer';
import { suggestMapping, targetFields } from './ingest/targetFields';
import type { CostTypeAssignment, CostTypeCombination, CostTypeDef, ExportDiagramRequest, IpcResult, LineageResult, Module, QueryResult, SchemaDescription, SchemaTable, StageRequest, WorkPackageAssignment, WorkPackageCombination, WorkPackageDef } from '../shared/types';

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

function loadCostTypeDefs(): CostTypeDef[] {
  return getDb().prepare(
    `SELECT code, label, icon, color, sort_order, is_system FROM dim_cost_type ORDER BY sort_order, code`,
  ).all() as CostTypeDef[];
}

/** A₋Z 0-9 upper-snake code from a display name, e.g. "Asset Depreciation" → ASSET_DEPRECIATION. */
function slugifyCostType(label: string): string {
  return label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Shared by the work-package combinations list, same reasoning as loadCostTypeCombinations. */
function loadWorkPackageCombinations(): WorkPackageCombination[] {
  return getDb().prepare(`
    SELECT a.cost_element_code, a.cost_element_name,
           COALESCE(a.wbs_code,'') AS wbs_code, a.wbs_name,
           COUNT(*) AS postings, SUM(a.amount) AS amount,
           a.work_package AS resolved_work_package,
           (SELECT r.work_package FROM work_package_rule r
             WHERE r.is_active = 1
               AND r.cost_element_glob = a.cost_element_code
               AND r.wbs_glob = COALESCE(a.wbs_code,'')
             ORDER BY r.priority, r.rule_id LIMIT 1) AS assigned_work_package
    FROM v_actual a
    GROUP BY a.cost_element_code, a.cost_element_name,
             COALESCE(a.wbs_code,''), a.wbs_name, a.work_package
    ORDER BY ABS(SUM(a.amount)) DESC`).all() as WorkPackageCombination[];
}

function loadWorkPackageDefs(): WorkPackageDef[] {
  return getDb().prepare(
    `SELECT code, label, icon, color, sort_order, is_system FROM dim_work_package ORDER BY sort_order, code`,
  ).all() as WorkPackageDef[];
}

/** Same slugging rule as cost types, so a work package code reads the same way. */
function slugifyWorkPackage(label: string): string {
  return label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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
   * Every (cost element, document type) pair that actually occurs in posted cost.
   *
   * Derived from the data, not typed in, so the list is exactly what needs an
   * answer. `assigned_cost_type` is filled only when a rule names the pair
   * outright — anything else is inherited from a pattern and shown as such, so
   * the user can see which answers they have given and which were guessed.
   */
  handle('costTypes:combinations', () => loadCostTypeCombinations());

  /** The cost types available to pick from, in display order. */
  handle('costTypes:types', () => loadCostTypeDefs());

  /**
   * Add a cost type. The code is derived from the name and fixed from then on
   * — everything else (rules, exports) stores the code, so letting it change
   * after the fact would silently orphan history. Renaming is a separate call.
   */
  handle('costTypes:typeCreate', (input: { label: string; icon: string; color: string }) => {
    const db = getDb();
    const label = (input.label ?? '').trim();
    if (!label) throw new Error('A cost type needs a name.');
    const code = slugifyCostType(label);
    if (!code) throw new Error('That name has no usable letters or numbers.');
    if (db.prepare('SELECT 1 FROM dim_cost_type WHERE code = ?').get(code)) {
      throw new Error(`A cost type named "${label}" already exists.`);
    }
    const { m } = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM dim_cost_type').get() as { m: number };
    db.prepare(`INSERT INTO dim_cost_type (code, label, icon, color, sort_order, is_system)
                VALUES (?, ?, ?, ?, ?, 0)`)
      .run(code, label, input.icon || '❓', input.color || '#9aa5b1', m + 10);
    return loadCostTypeDefs();
  });

  /** Rename a cost type or change its icon/colour — the code never changes. */
  handle('costTypes:typeUpdate', (input: { code: string; label: string; icon: string; color: string }) => {
    const db = getDb();
    const row = db.prepare('SELECT code FROM dim_cost_type WHERE code = ?').get(input.code);
    if (!row) throw new Error('That cost type no longer exists.');
    const label = (input.label ?? '').trim();
    if (!label) throw new Error('A cost type needs a name.');
    db.prepare('UPDATE dim_cost_type SET label = ?, icon = ?, color = ? WHERE code = ?')
      .run(label, input.icon || '❓', input.color || '#9aa5b1', input.code);
    return loadCostTypeDefs();
  });

  /** Only a user-added cost type can be deleted, and only once nothing points at it. */
  handle('costTypes:typeDelete', (code: string) => {
    const db = getDb();
    const row = db.prepare('SELECT is_system FROM dim_cost_type WHERE code = ?').get(code) as
      { is_system: number } | undefined;
    if (!row) return loadCostTypeDefs();
    if (row.is_system) throw new Error('This is one of the built-in cost types and cannot be deleted.');
    try {
      db.prepare('DELETE FROM dim_cost_type WHERE code = ?').run(code);
    } catch {
      throw new Error('This cost type is still assigned to some cost — clear those allocations first.');
    }
    return loadCostTypeDefs();
  });

  handle('costTypes:exportMapping', async () => {
    const res = await dialog.showSaveDialog({
      title: 'Export cost type mapping',
      defaultPath: join(app.getPath('documents'), `Cost type mapping ${new Date().toISOString().slice(0, 10)}.xlsx`),
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await exportCostTypeMapping(res.filePath, loadCostTypeCombinations(), loadCostTypeDefs().map((t) => t.code));
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
    const knownTypes = new Set(loadCostTypeDefs().map((t) => t.code));
    for (const it of items) {
      if (it.cost_type !== null && !knownTypes.has(it.cost_type)) {
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

  /**
   * Every (cost element, WBS) pair that actually occurs in posted actual cost —
   * the work-package allocation screen's unit of work, mirroring costTypes:*
   * exactly but keyed on where the cost sits rather than its document type.
   */
  handle('workPackages:combinations', () => loadWorkPackageCombinations());

  /** The work packages available to pick from, in display order. */
  handle('workPackages:types', () => loadWorkPackageDefs());

  handle('workPackages:typeCreate', (input: { label: string; icon: string; color: string }) => {
    const db = getDb();
    const label = (input.label ?? '').trim();
    if (!label) throw new Error('A work package needs a name.');
    const code = slugifyWorkPackage(label);
    if (!code) throw new Error('That name has no usable letters or numbers.');
    if (db.prepare('SELECT 1 FROM dim_work_package WHERE code = ?').get(code)) {
      throw new Error(`A work package named "${label}" already exists.`);
    }
    const { m } = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM dim_work_package').get() as { m: number };
    db.prepare(`INSERT INTO dim_work_package (code, label, icon, color, sort_order, is_system)
                VALUES (?, ?, ?, ?, ?, 0)`)
      .run(code, label, input.icon || '📦', input.color || '#9aa5b1', m + 10);
    return loadWorkPackageDefs();
  });

  handle('workPackages:typeUpdate', (input: { code: string; label: string; icon: string; color: string }) => {
    const db = getDb();
    const row = db.prepare('SELECT code FROM dim_work_package WHERE code = ?').get(input.code);
    if (!row) throw new Error('That work package no longer exists.');
    const label = (input.label ?? '').trim();
    if (!label) throw new Error('A work package needs a name.');
    db.prepare('UPDATE dim_work_package SET label = ?, icon = ?, color = ? WHERE code = ?')
      .run(label, input.icon || '📦', input.color || '#9aa5b1', input.code);
    return loadWorkPackageDefs();
  });

  handle('workPackages:typeDelete', (code: string) => {
    const db = getDb();
    const row = db.prepare('SELECT is_system FROM dim_work_package WHERE code = ?').get(code) as
      { is_system: number } | undefined;
    if (!row) return loadWorkPackageDefs();
    try {
      db.prepare('DELETE FROM dim_work_package WHERE code = ?').run(code);
    } catch {
      throw new Error('This work package is still assigned to some cost — clear those allocations first.');
    }
    return loadWorkPackageDefs();
  });

  /**
   * Allocate a work package to named pairs — exact rules at priority 1, same
   * reasoning as costTypes:assign: an allocation and a rule are the same kind
   * of thing, and a pair occurs once so two allocations can never disagree.
   */
  handle('workPackages:assign', (items: WorkPackageAssignment[]) => {
    const db = getDb();
    const known = new Set(loadWorkPackageDefs().map((t) => t.code));
    for (const it of items) {
      if (it.work_package !== null && !known.has(it.work_package)) {
        throw new Error(`"${it.work_package}" is not a work package.`);
      }
      for (const v of [it.cost_element_code, it.wbs_code]) {
        if (/[*?[\]]/.test(v)) throw new Error(`"${v}" contains a wildcard character and cannot be allocated directly.`);
      }
    }
    const del = db.prepare(`DELETE FROM work_package_rule
                            WHERE cost_element_glob = ? AND wbs_glob = ?`);
    const ins = db.prepare(`INSERT INTO work_package_rule
      (priority, cost_element_glob, wbs_glob, work_package, note)
      VALUES (1, ?, ?, ?, ?)`);
    let assigned = 0, cleared = 0;
    const run = db.transaction(() => {
      for (const it of items) {
        del.run(it.cost_element_code, it.wbs_code);
        if (it.work_package === null) { cleared++; continue; }
        ins.run(it.cost_element_code, it.wbs_code, it.work_package,
          `Allocated for WBS ${it.wbs_code || '(none)'}`);
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

  // A sample of the actually-staged, post-mapping/post-transform rows for a
  // batch — what Upload.tsx's review step shows so the user sees real staged
  // data, not just a client-side guess at the mapping.
  handle('import:preview', (batchId: number, limit = 8): Record<string, unknown>[] => {
    const rows = getDb().prepare(`SELECT raw_json FROM stg_row
                     WHERE import_batch_id = ? AND status = 'VALID'
                     ORDER BY row_no LIMIT ?`).all(batchId, limit) as { raw_json: string }[];
    return rows.map((r) => {
      const { mapped } = JSON.parse(r.raw_json) as { mapped: Record<string, unknown> };
      return Object.fromEntries(Object.entries(mapped ?? {}).filter(([k]) => !k.startsWith('__')));
    });
  });

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

  // --- schema ----------------------------------------------------------------
  handle('schema:describe', (): SchemaDescription => {
    const conn = getDb();
    const tableNames = (conn.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migration'
       ORDER BY name`).all() as { name: string }[]).map((r) => r.name);

    const tables: SchemaTable[] = tableNames.map((name) => ({
      name,
      columns: (conn.prepare(`PRAGMA table_info(${name})`).all() as any[])
        .map((c) => ({ name: c.name, type: c.type, notNull: !!c.notnull, isPk: c.pk > 0 })),
      foreignKeys: (conn.prepare(`PRAGMA foreign_key_list(${name})`).all() as any[])
        .map((f) => ({ column: f.from, refTable: f.table, refColumn: f.to })),
    }));

    return { tables };
  });

  handle('lineage:forReport', (reportDefinitionId: number): LineageResult => buildLineage(reportDefinitionId));

  handle('export:diagram', async (req: ExportDiagramRequest): Promise<string | null> => {
    const res = await dialog.showSaveDialog({
      title: 'Export diagram',
      defaultPath: join(app.getPath('documents'), `${req.suggestedName}.${req.format}`),
      filters: [{ name: req.format.toUpperCase(), extensions: [req.format] }],
    });
    if (res.canceled || !res.filePath) return null;
    if (req.format === 'svg') writeFileSync(res.filePath, req.data, 'utf8');
    else writeFileSync(res.filePath, Buffer.from(req.data, 'base64'));
    return res.filePath;
  });

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
