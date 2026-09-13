import ExcelJS from 'exceljs';
import type { QueryResult } from '../../shared/types';

const MONEY_HINT = /(amount|budget|actual|forecast|etc|eac|vac|variance|cost|value|overrun|total|cum)/i;
const PCT_HINT = /(pct|percent|_%|ratio)/i;
const INT_HINT = /(count|rows|_no$|documents|days)/i;

/**
 * Write a result set to a formatted worksheet: styled header, frozen top row,
 * autofilter, sensible number formats and a totals row for money columns.
 */
export async function exportResult(
  filePath: string,
  result: QueryResult,
  meta: { title: string; subtitle?: string; context?: Record<string, unknown> },
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Cost Intelligence';
  wb.created = new Date();

  const ws = wb.addWorksheet('Data', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = result.columns.map((c) => ({
    header: c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
    key: c,
    width: Math.min(Math.max(c.length + 4, 12), 46),
  }));

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  head.height = 26;

  for (const row of result.rows) ws.addRow(row);

  result.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (PCT_HINT.test(c)) col.numFmt = '#,##0.0"%"';
    else if (INT_HINT.test(c)) col.numFmt = '#,##0';
    else if (MONEY_HINT.test(c)) col.numFmt = '#,##0.00;[Red](#,##0.00)';
  });

  if (result.rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: result.columns.length } };

    const totalRow = ws.addRow({});
    totalRow.font = { bold: true };
    totalRow.border = { top: { style: 'thin' } };
    totalRow.getCell(1).value = 'TOTAL';
    result.columns.forEach((c, i) => {
      if (!MONEY_HINT.test(c) || PCT_HINT.test(c)) return;
      const letter = ws.getColumn(i + 1).letter;
      totalRow.getCell(i + 1).value = { formula: `SUM(${letter}2:${letter}${result.rows.length + 1})` } as any;
    });
  }

  // Lineage sheet — an exported file must be able to say where its numbers came from.
  const info = wb.addWorksheet('Report info');
  info.columns = [{ width: 28 }, { width: 70 }];
  const lines: [string, unknown][] = [
    ['Report', meta.title],
    ['Description', meta.subtitle ?? ''],
    ['Exported at', new Date().toISOString().replace('T', ' ').slice(0, 19)],
    ['Rows', result.rowCount],
    ['Query time (ms)', result.ms],
    ...Object.entries(meta.context ?? {}).map(([k, v]) => [k, v] as [string, unknown]),
  ];
  lines.forEach(([k, v]) => {
    const r = info.addRow([k, v === null || v === undefined ? '' : String(v)]);
    r.getCell(1).font = { bold: true };
  });

  await wb.xlsx.writeFile(filePath);
  return filePath;
}
