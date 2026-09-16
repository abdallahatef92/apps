import ExcelJS from 'exceljs';
import type { CostTypeCombination, QueryResult } from '../../shared/types';

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

const COST_TYPE_ORDER = ['UNMAPPED', 'LABOR', 'MATERIAL', 'SUBCONTRACT', 'EQUIPMENT', 'INDIRECT', 'OTHER'];

/** GL description if the file gave one, falling back to the code alone. */
const glLabel = (c: { cost_element_code: string; cost_element_name?: string | null }) =>
  c.cost_element_name ? `${c.cost_element_name} (${c.cost_element_code})` : c.cost_element_code;

/**
 * The cost-type allocation grid, grouped by cost type — UNMAPPED first —
 * with each type's GL + document-type combinations nested beneath, sorted by
 * GL description rather than code. Mirrors the on-screen grouping so the
 * export is a record of the same view, not a different cut of the data.
 * Uses Excel's own outline/group feature (the +/- margin buttons) rather
 * than simulating collapse with indentation, so the file is genuinely
 * expand/collapse-able in Excel itself, not just a flat dump.
 */
export async function exportCostTypeMapping(filePath: string, combos: CostTypeCombination[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Cost Intelligence';
  wb.created = new Date();

  const ws = wb.addWorksheet('Cost type mapping', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { outlineProperties: { summaryBelow: false, summaryRight: false } },
  });

  ws.columns = [
    { header: 'Cost type / GL', key: 'label', width: 40 },
    { header: 'Doc type', key: 'doc_type', width: 12 },
    { header: 'Postings', key: 'postings', width: 12 },
    { header: 'Amount', key: 'amount', width: 16 },
    { header: 'Allocated?', key: 'allocated', width: 12 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  head.height = 26;

  const byType = new Map<string, CostTypeCombination[]>();
  for (const c of combos) {
    const key = c.resolved_cost_type ?? 'UNMAPPED';
    const list = byType.get(key) ?? [];
    list.push(c);
    byType.set(key, list);
  }
  const types = [...byType.keys()].sort((a, b) => COST_TYPE_ORDER.indexOf(a) - COST_TYPE_ORDER.indexOf(b));

  for (const type of types) {
    const rows = [...byType.get(type)!].sort((a, b) =>
      glLabel(a).localeCompare(glLabel(b)) || a.document_type.localeCompare(b.document_type));
    const totalPostings = rows.reduce((s, r) => s + r.postings, 0);
    const totalAmount = rows.reduce((s, r) => s + r.amount, 0);

    const typeRow = ws.addRow({
      label: type, doc_type: '', postings: totalPostings, amount: totalAmount, allocated: '',
    });
    typeRow.font = { bold: true };
    typeRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };

    for (const r of rows) {
      const detail = ws.addRow({
        label: `  ${glLabel(r)}`, doc_type: r.document_type || '(none)',
        postings: r.postings, amount: r.amount, allocated: r.assigned_cost_type ? 'Yes' : 'inherited',
      });
      detail.outlineLevel = 1;
    }
  }

  ws.getColumn('amount').numFmt = '#,##0.00;[Red](#,##0.00)';
  ws.getColumn('postings').numFmt = '#,##0';
  if (combos.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };
  }

  const info = wb.addWorksheet('Report info');
  info.columns = [{ width: 28 }, { width: 70 }];
  [['Report', 'Cost type mapping — grouped by cost type, GL sorted by description'],
   ['Exported at', new Date().toISOString().replace('T', ' ').slice(0, 19)],
   ['Cost types', types.length],
   ['Combinations', combos.length]].forEach(([k, v]) => {
    const r = info.addRow([k, v]);
    r.getCell(1).font = { bold: true };
  });

  await wb.xlsx.writeFile(filePath);
  return filePath;
}
