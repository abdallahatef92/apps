import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db';
import { runStoredQuery } from './queryRunner';
import { buildRegisterWorkbook } from './registerReport';
import { buildSubcontractReport } from './subcontractReport';
import { buildMaterialReport } from './materialReport';

/**
 * The monthly pack (simplification step 4): one folder per project and cut-off month holding the reports
 * issued each month — the Actual cost register, and the Subcontract / Material workbooks when their source
 * is loaded. Each workbook is the same one its page exports; this only decides which apply and writes them
 * side by side, so a month is closed with one click.
 */

export interface MonthlyPackResult {
  folder: string;
  files: string[];
  skipped: { report: string; reason: string }[];
}

export async function writeMonthlyPack(projectKey: number, parentDir: string): Promise<MonthlyPackResult> {
  const db = getDb();
  const project = db.prepare('SELECT project_code FROM dim_project WHERE project_key = ?').get(projectKey) as
    { project_code: string } | undefined;
  if (!project) throw new Error('Choose a project first.');
  const month = String((runStoredQuery('REG_KPI', { project_key: projectKey }).rows[0] as Record<string, unknown>)?.report_month ?? 'all');
  const safe = project.project_code.replace(/[^A-Za-z0-9_-]+/g, '_');
  const folder = join(parentDir, `${safe}_Monthly_Pack_${month}`);
  mkdirSync(folder, { recursive: true });

  const files: string[] = [];
  const skipped: MonthlyPackResult['skipped'] = [];
  const write = (fileName: string, buffer: Uint8Array | Buffer) => {
    const p = join(folder, fileName);
    writeFileSync(p, buffer);
    files.push(p);
  };

  const reg = await buildRegisterWorkbook(projectKey, null, null);
  write(reg.fileName, reg.buffer);

  const hasCertificates = !!db.prepare(`
    SELECT 1 FROM fact_service_line f JOIN import_batch b ON b.import_batch_id = f.import_batch_id
    WHERE f.project_key = ? AND b.status = 'POSTED' LIMIT 1`).get(projectKey);
  if (hasCertificates) {
    const sc = await buildSubcontractReport(projectKey);
    write(sc.fileName, sc.buffer);
  } else skipped.push({ report: 'Subcontract cost report', reason: 'no ZSCPROG01 certificates loaded' });

  const hasMb51 = !!db.prepare('SELECT 1 FROM v_mb51_project WHERE project_key = ?').get(projectKey);
  if (hasMb51) {
    const mat = await buildMaterialReport(projectKey);
    write(mat.fileName, mat.buffer);
  } else skipped.push({ report: 'Material cost report', reason: 'no MB51 issues loaded' });

  return { folder, files, skipped };
}
