import { getDb } from '../db';
import { loadColumnMapping, stageRows } from '../ingest/importer';
import { DEFAULT_EXTRACT, pullRows, type Fetcher } from './odata';
import type { SapConnection, SapExtract, SapPullResult } from '../../shared/types';

/** The report definition a live pull stages into (migration 028). */
export const S4_REPORT_CODE = 'S4_JOURNAL_ITEMS';

const CONNECTION_KEY = 'sap.connection';
const EXTRACT_KEY = 'sap.extract';

const DEFAULT_CONNECTION: SapConnection = { baseUrl: '', client: '', user: '', language: 'EN' };

function readSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return { ...fallback, ...JSON.parse(row.value) };
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: unknown): void {
  getDb().prepare(`INSERT INTO app_setting (key, value) VALUES (?,?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(key, JSON.stringify(value));
}

/** Connection and extract as last used. Never contains a password. */
export function loadSapSettings(): { connection: SapConnection; extract: SapExtract } {
  return {
    connection: readSetting(CONNECTION_KEY, DEFAULT_CONNECTION),
    extract: readSetting(EXTRACT_KEY, DEFAULT_EXTRACT),
  };
}

export function saveSapSettings(connection: SapConnection, extract: SapExtract): void {
  writeSetting(CONNECTION_KEY, connection);
  writeSetting(EXTRACT_KEY, extract);
}

/**
 * Pull from SAP and stage the result. Nothing is posted: the caller shows the
 * same review as an upload and posts only when the user says so.
 */
export async function pullAndStage(opts: {
  connection: SapConnection;
  extract: SapExtract;
  password: string;
  projectKey: number;
  dataDate: string;
  importedBy: string | null;
  fetcher: Fetcher;
}): Promise<SapPullResult> {
  const db = getDb();
  const rd = db.prepare('SELECT report_definition_id, detail_key_fields FROM report_definition WHERE code = ?')
    .get(S4_REPORT_CODE) as { report_definition_id: number; detail_key_fields: string } | undefined;
  if (!rd) throw new Error(`Report definition ${S4_REPORT_CODE} is missing — the database is older than the app.`);

  const project = db.prepare('SELECT project_code FROM dim_project WHERE project_key = ?')
    .get(opts.projectKey) as { project_code: string } | undefined;
  if (!project) throw new Error('Choose the project this cost belongs to.');

  // Never an unscoped pull: with no prefix given, the project code is the prefix,
  // which is how SAP numbers a project's WBS. The screen applies the same rule.
  const extract = { ...opts.extract, wbsPrefix: opts.extract.wbsPrefix.trim() || project.project_code };
  const pulled = await pullRows(opts.connection, opts.password, extract, opts.fetcher);

  // The saved mapping is the contract. A column SAP did not send is dropped from
  // it rather than staged as blank — and named, so a renamed field is noticed.
  const saved = loadColumnMapping(rd.report_definition_id);
  const present = new Set(pulled.columns);
  const mapping = saved.filter((m) => m.source_column && present.has(m.source_column));
  const missingColumns = pulled.rows.length === 0
    ? []
    : saved.filter((m) => m.source_column && !present.has(m.source_column)).map((m) => m.source_column!);

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const stage = stageRows({
    filePath: pulled.url,
    fileName: `S/4HANA ${extract.entitySet} ${extract.wbsPrefix} ${stamp}`,
    fileHash: pulled.hash,
    fileSize: pulled.bytes,
    sheetName: extract.entitySet,
    headerRow: 0,
    module: 'ACTUAL',
    reportDefinitionId: rd.report_definition_id,
    dataDate: opts.dataDate,
    periodKey: null,
    projectKey: opts.projectKey,
    scenarioKey: null,
    notes: `Live pull. $filter: ${pulled.filter || '(none)'}`,
    mapping,
    saveMapping: false,
  }, pulled.rows, opts.importedBy);

  // Cost already posted on this project by another actual source would not merge
  // with this pull — different document numbers — and would be counted twice.
  const otherActualSources = db.prepare(`
    SELECT rd.name AS report_name, COUNT(*) AS postings
    FROM v_posting p JOIN report_definition rd ON rd.report_definition_id = p.report_definition_id
    WHERE p.project_key = ? AND rd.module = 'ACTUAL' AND rd.code <> ?
    GROUP BY rd.name ORDER BY rd.name`).all(opts.projectKey, S4_REPORT_CODE) as
    { report_name: string; postings: number }[];

  return {
    stage,
    url: pulled.url,
    filter: pulled.filter,
    columns: pulled.columns,
    missingColumns,
    otherActualSources,
  };
}
