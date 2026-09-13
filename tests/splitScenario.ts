/**
 * Reproduces the reported workflow against the genuine CJI3 export: split the
 * extract by month, load the parts, then re-run one with a different posting
 * period. The project total must stay put throughout.
 *
 *   npm run check:split -- <cji3.xlsx>
 */
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, getDb } from '../src/main/db';
import { readWorkbook } from '../src/main/ingest/workbook';
import { suggestMapping } from '../src/main/ingest/targetFields';
import { postBatch, stageFile } from '../src/main/ingest/importer';
import type { ColumnMappingEntry } from '../src/shared/types';

const [srcPath] = process.argv.slice(2);
let failures = 0;
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function near(label: string, actual: number, expected: number): void {
  if (Math.abs(actual - expected) < 0.02) console.log(`  ok   ${label} — ${fmt(actual)}`);
  else { failures++; console.error(`  FAIL ${label} — got ${fmt(actual)}, expected ${fmt(expected)}`); }
}

/** Write a copy of the export containing only rows whose fiscal year matches. */
async function splitByYear(src: string, out: string, year: string): Promise<number> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(src);
  const ws = wb.worksheets[0];
  const header: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => {
    const v = c.value as any;
    header[i] = String((v && typeof v === 'object' ? v.result ?? v.text : v) ?? '');
  });
  const yearCol = header.findIndex((h) => h === 'Fiscal Year');
  const docCol = header.findIndex((h) => h === 'Document Number');

  const out_ = new ExcelJS.Workbook();
  const ows = out_.addWorksheet('Data');
  ows.addRow(header.slice(1));
  let kept = 0;
  ws.eachRow((row, i) => {
    if (i === 1) return;
    // Dates are objects too — take them before unwrapping formula/rich-text cells,
    // or every posting date in the copy comes out null.
    const cell = (n: number) => {
      const v = row.getCell(n).value as any;
      if (v instanceof Date) return v;
      return v && typeof v === 'object' ? v.result ?? v.text ?? null : v;
    };
    if (String(cell(docCol) ?? '').trim() === '') return;   // drop subtotals
    if (String(cell(yearCol) ?? '') !== year) return;
    const vals: unknown[] = [];
    for (let k = 1; k < header.length; k++) vals.push(cell(k));
    ows.addRow(vals);
    kept++;
  });
  await out_.xlsx.writeFile(out);
  return kept;
}

async function load(dbFile: string, filePath: string, label: string,
                    dataDate: string, period: string | null, projectKey: number) {
  const preview = await readWorkbook(filePath);
  const sheet = preview.sheets[0];
  const mapping: ColumnMappingEntry[] = Object.entries(suggestMapping('ACTUAL', sheet.columns))
    .map(([target_field, source_column]) => ({ target_field, source_column }));
  const staged = await stageFile({
    filePath, fileName: label, fileHash: preview.fileHash, fileSize: preview.fileSize,
    sheetName: sheet.sheetName, headerRow: sheet.headerRow, module: 'ACTUAL',
    reportDefinitionId: 6, dataDate, periodKey: period, projectKey,
    scenarioKey: null, notes: null, mapping, saveMapping: false,
  }, 'split-check');
  const posted = postBatch(staged.importBatchId);
  console.log(`  ${label}: read ${staged.rowCount}, valid ${staged.validCount}, ` +
    `skipped ${staged.skippedCount}, rejected ${staged.errorCount}, ` +
    `key ${staged.lineKey.used.join('+') || 'none'} (usable ${staged.lineKey.usable}), ` +
    `posted ${posted.posted} of which ${posted.replaced} replaced`);
  if (staged.errorCount > 0) console.log('    first error:', staged.issues.find((i) => i.severity === 'ERROR')?.message);
  if (staged.rowCount === 0) console.log('    columns:', sheet.columns.slice(0, 6).join(' | '), '… headerRow', sheet.headerRow);
  return { staged, posted };
}

const cost = () =>
  Number((getDb().prepare('SELECT COALESCE(SUM(amount),0) a FROM v_actual').get() as any).a);

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ci-split-'));
  openDatabase(join(dir, 'split.db'));
  const projectKey = Number(getDb()
    .prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
    .run('C-DIST', 'District 5').lastInsertRowid);

  const p2025 = join(dir, 'cji3-2025.xlsx');
  const p2026 = join(dir, 'cji3-2026.xlsx');
  const n2025 = await splitByYear(srcPath, p2025, '2025');
  const n2026 = await splitByYear(srcPath, p2026, '2026');
  console.log(`\nsplit the export: ${n2025} rows in FY2025, ${n2026} in FY2026\n`);

  await load('', p2025, 'cji3 FY2025.xlsx', '2025-12-31', null, projectKey);
  const afterFirst = cost();
  await load('', p2026, 'cji3 FY2026.xlsx', '2026-09-13', null, projectKey);
  const afterBoth = cost();
  console.log();
  near('the two parts add up', afterBoth, afterFirst + (afterBoth - afterFirst));

  const full = await load('', srcPath, 'cji3 - dist.xlsx', '2026-09-13', null, projectKey);
  near('loading the full export over both parts changes nothing', cost(), afterBoth);
  if (full.posted.replaced !== full.posted.posted) {
    failures++;
    console.error(`  FAIL every row of the full export should have replaced one — ` +
      `${full.posted.replaced} of ${full.posted.posted}`);
  } else {
    console.log(`  ok   all ${full.posted.posted} rows merged onto existing lines`);
  }

  // The reported trigger: same content, different posting period on the batch.
  await load('', srcPath, 'cji3 - dist.xlsx', '2026-09-13', '2026-08', projectKey);
  near('re-running with a different posting period changes nothing', cost(), afterBoth);

  console.log(`\n  project total: ${fmt(cost())}`);
  console.log(failures === 0 ? '\nAll split checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
