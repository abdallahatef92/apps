import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { FilePreview, SheetPreview } from '../../shared/types';

const PREVIEW_ROWS = 200;
const HEADER_SCAN_ROWS = 25;

export function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value as any;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    // Formula cells carry {formula, result}; hyperlinks {text, hyperlink};
    // rich text {richText:[{text}]}. Always take the displayed value.
    if ('result' in v) return v.result ?? null;
    if ('text' in v) return v.text;
    if ('richText' in v) return v.richText.map((r: any) => r.text).join('');
    if ('error' in v) return null;
  }
  return v;
}

/**
 * SAP and cost-report exports rarely start at A1 — there are title blocks,
 * run dates and blank spacer rows first. Pick the row that looks most like a
 * header: the most non-empty, mostly-textual, distinct cells.
 */
function detectHeaderRow(rows: unknown[][]): number {
  let best = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i] ?? [];
    const filled = cells.filter((c) => c !== null && c !== undefined && String(c).trim() !== '');
    if (filled.length < 2) continue;
    const textual = filled.filter((c) => typeof c === 'string' && !/^-?[\d.,]+$/.test(c.trim()));
    const distinct = new Set(filled.map((c) => String(c).trim().toLowerCase())).size;
    const score = filled.length + textual.length * 2 + distinct - i * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function uniqueHeaders(raw: unknown[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = h === null || h === undefined || String(h).trim() === ''
      ? `Column ${i + 1}`
      : String(h).trim().replace(/\s+/g, ' ');
    const n = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    return name;
  });
}

const DATE_HINTS = /(as[ _-]?of|data[ _-]?date|report(ing)?[ _-]?date|run[ _-]?date|period[ _-]?end|key[ _-]?date)\D{0,20}(\d{1,4}[./-]\d{1,2}[./-]\d{1,4})/i;

function normaliseDate(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
  // Ambiguous d/m vs m/d: treat >12 in the first slot as the day, else assume d/m/y
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
    return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

/** Best-effort guess at the report's as-of date; the user always confirms it. */
function detectDataDate(rows: unknown[][], headerRow: number, fileName: string): string | null {
  for (let i = 0; i < Math.min(headerRow + 1, rows.length); i++) {
    const line = (rows[i] ?? []).map((c) => (c == null ? '' : String(c))).join(' ');
    const hit = DATE_HINTS.exec(line);
    if (hit) {
      const d = normaliseDate(hit[3]);
      if (d) return d;
    }
  }
  const fm = /(20\d{2})[._-]?(0[1-9]|1[0-2])(?:[._-]?(0[1-9]|[12]\d|3[01]))?/.exec(basename(fileName));
  if (fm) {
    const y = Number(fm[1]);
    const mo = Number(fm[2]);
    const day = fm[3] ? Number(fm[3]) : new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function sheetToPreview(ws: ExcelJS.Worksheet): SheetPreview {
  const grid: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellValue(cell)));
    grid.push(cells);
  });

  const headerRow = detectHeaderRow(grid);
  const columns = uniqueHeaders(grid[headerRow] ?? []);
  const body = grid.slice(headerRow + 1)
    .filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));

  const rows = body.slice(0, PREVIEW_ROWS).map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => { o[c] = r[i] ?? null; });
    return o;
  });

  return { sheetName: ws.name, headerRow, columns, rows, totalRows: body.length };
}

/** Read a workbook and return a preview of every sheet, plus file lineage info. */
export async function readWorkbook(filePath: string): Promise<FilePreview> {
  const wb = new ExcelJS.Workbook();
  const ext = extname(filePath).toLowerCase();
  if (ext === '.csv') {
    await wb.csv.readFile(filePath);
  } else {
    await wb.xlsx.readFile(filePath);
  }

  const sheets = wb.worksheets.filter((ws) => ws.rowCount > 0).map(sheetToPreview);
  const stat = statSync(filePath);

  let detected: string | null = null;
  for (const ws of wb.worksheets) {
    const grid: unknown[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (n > HEADER_SCAN_ROWS) return;
      const cells: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellValue(cell)));
      grid.push(cells);
    });
    detected = detectDataDate(grid, HEADER_SCAN_ROWS, filePath);
    if (detected) break;
  }

  return {
    filePath,
    fileName: basename(filePath),
    fileSize: stat.size,
    fileHash: hashFile(filePath),
    sheets,
    detectedDataDate: detected,
  };
}

/** Read every data row of one sheet (used at staging time, not for preview). */
export async function readSheetRows(
  filePath: string,
  sheetName: string,
  headerRow: number,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const wb = new ExcelJS.Workbook();
  if (extname(filePath).toLowerCase() === '.csv') {
    await wb.csv.readFile(filePath);
  } else {
    await wb.xlsx.readFile(filePath);
  }
  const ws = wb.getWorksheet(sheetName) ?? wb.worksheets[0];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found in ${basename(filePath)}.`);

  const grid: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellValue(cell)));
    grid.push(cells);
  });

  const columns = uniqueHeaders(grid[headerRow] ?? []);
  const rows = grid.slice(headerRow + 1)
    .filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''))
    .map((r) => {
      const o: Record<string, unknown> = {};
      columns.forEach((c, i) => { o[c] = r[i] ?? null; });
      return o;
    });

  return { columns, rows };
}
