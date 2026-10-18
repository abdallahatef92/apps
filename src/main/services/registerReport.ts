import ExcelJS from 'exceljs';
import { getDb } from '../db';
import { runStoredQuery } from './queryRunner';
import { fixSheetPrOrder } from './xlsxFix';

/**
 * The Actual cost register as a workbook: "Per month" (category › row, unit, quantity to date, cumulative to the
 * cut-off, then one column per month; category subtotals and a grand total) and "Lines". Every figure comes from REG_MONTHLY / REG_LINES — the
 * same queries as the page; this file only lays the long result out as columns, the way the page's
 * MonthPivot does, and writes subtotals as SUM formulas so the sheet stays live when edited.
 */

interface Row { category: string; cost_type: string | null; item_key: string; item: string; src: string; unit: string | null; period_key: string; amount: number; qty: number | null }

const MONEY = '#,##0;(#,##0);-';
const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const GROUP_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
const MONTH_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

export async function buildRegisterWorkbook(projectKey: number, rowsBy: string | null, source: string | null):
  Promise<{ buffer: Buffer; fileName: string }> {
  const db = getDb();
  const project = db.prepare('SELECT project_code FROM dim_project WHERE project_key = ?').get(projectKey) as { project_code: string } | undefined;
  const kpi = runStoredQuery('REG_KPI', { project_key: projectKey }).rows[0] as Record<string, unknown>;
  const reportMonth = String(kpi.report_month ?? '');
  const long = runStoredQuery('REG_MONTHLY', { project_key: projectKey, rows_by: rowsBy, source }).rows as unknown as Row[];
  const lines = runStoredQuery('REG_LINES', { project_key: projectKey, rows_by: rowsBy, source, cost_type: null, item_key: null });

  const periods = [...new Set(long.map((r) => r.period_key))].sort();
  // rows in query order (category, then largest first), one per category + row key
  const order: string[] = [];
  const byKey = new Map<string, { category: string; item: string; src: string; unit: string; qty: number; cells: Map<string, number> }>();
  for (const r of long) {
    const k = `${r.category}\u0001${r.item_key}`;
    let row = byKey.get(k);
    if (!row) { row = { category: r.category, item: r.item, src: r.src, unit: r.unit ?? '', qty: 0, cells: new Map() }; byKey.set(k, row); order.push(k); }
    row.cells.set(r.period_key, (row.cells.get(r.period_key) ?? 0) + Number(r.amount));
    row.qty += Number(r.qty ?? 0);
  }
  const rowLabel = rowsBy === 'package' ? 'Work package' : rowsBy === 'wbs' ? 'WBS' : 'Item';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Cost Intelligence';
  const title = `${project?.project_code ?? 'Project'} — Actual cost register`;
  const subtitle = `Cut-off month ${reportMonth || '—'} · actual to cut-off ${Number(kpi.actual_to_cutoff ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    + `${source ? ` · source ${source}` : ''}`;

  const byItem = !rowsBy || rowsBy === 'item';   // quantity and unit mean something per item only
  const ws = wb.addWorksheet('Per month', { views: [{ state: 'frozen', xSplit: byItem ? 6 : 4, ySplit: 4 }] });
  ws.getCell('A1').value = title; ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = subtitle; ws.getCell('A2').font = { italic: true, color: { argb: 'FF595959' } };
  const cumLabel = reportMonth ? `Cumulative to ${reportMonth}` : 'Cumulative';
  const fixed = byItem ? ['Category', rowLabel, 'Source', 'Unit', 'Qty to date', cumLabel] : ['Category', rowLabel, 'Source', cumLabel];
  const head = [...fixed, ...periods];
  const hr = ws.getRow(4);
  head.forEach((h, i) => {
    const c = hr.getCell(i + 1);
    c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD_FILL;
    c.alignment = { horizontal: i >= (byItem ? 4 : 3) ? 'right' : 'left' };
  });
  ws.getColumn(1).width = 22; ws.getColumn(2).width = 46; ws.getColumn(3).width = 12;
  if (byItem) { ws.getColumn(4).width = 8; ws.getColumn(5).width = 13; ws.getColumn(5).numFmt = '#,##0.00;(#,##0.00);-'; }
  const cumCol = fixed.length, firstP = fixed.length + 1, lastP = fixed.length + periods.length;
  for (let i = cumCol; i <= lastP; i++) { ws.getColumn(i).width = 14; ws.getColumn(i).numFmt = MONEY; }
  ws.getColumn(cumCol).width = 17;
  const col = (n: number) => ws.getColumn(n).letter;
  const monthCol = periods.indexOf(reportMonth);

  let r = 5;
  const groupRows: number[] = [];
  const categories = [...new Set(order.map((k) => byKey.get(k)!.category))];
  for (const cat of categories) {
    const keys = order.filter((k) => byKey.get(k)!.category === cat);
    const gRow = r++;
    groupRows.push(gRow);
    const first = r;
    for (const k of keys) {
      const row = byKey.get(k)!;
      const x = ws.getRow(r);
      x.getCell(2).value = row.item; x.getCell(3).value = row.src;
      if (byItem) { x.getCell(4).value = row.unit || null; if (row.qty) x.getCell(5).value = row.qty; }
      periods.forEach((p, i) => { const v = row.cells.get(p) ?? 0; if (v !== 0) x.getCell(firstP + i).value = v; });
      x.getCell(cumCol).value = { formula: `SUM(${col(firstP)}${r}:${col(lastP)}${r})` };
      x.getCell(cumCol).font = { bold: true };
      x.outlineLevel = 1;
      r++;
    }
    const g = ws.getRow(gRow);
    g.getCell(1).value = cat; g.getCell(2).value = `${keys.length} row${keys.length === 1 ? '' : 's'}`;
    // quantities are never added across rows (units differ)
    for (let c = cumCol; c <= lastP; c++) g.getCell(c).value = { formula: `SUBTOTAL(9,${col(c)}${first}:${col(c)}${r - 1})` };
    for (let c = 1; c <= lastP; c++) { g.getCell(c).font = { bold: true }; g.getCell(c).fill = GROUP_FILL; }
  }
  const t = ws.getRow(r);
  t.getCell(1).value = 'Total actual';
  for (let c = cumCol; c <= lastP; c++) t.getCell(c).value = { formula: `SUBTOTAL(9,${col(c)}5:${col(c)}${r - 1})` };
  for (let c = 1; c <= lastP; c++) { t.getCell(c).font = { bold: true }; t.getCell(c).border = { top: { style: 'medium' } }; }
  if (monthCol >= 0) for (let i = 5; i < r; i++) if (!groupRows.includes(i)) ws.getRow(i).getCell(firstP + monthCol).fill = MONTH_FILL;
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };

  const wl = wb.addWorksheet('Lines', { views: [{ state: 'frozen', ySplit: 1 }] });
  wl.columns = lines.columns.map((c) => ({ header: c.replace(/_/g, ' '), key: c, width: c === 'item' ? 46 : c === 'amount' ? 14 : 16 }));
  wl.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD_FILL; });
  for (const row of lines.rows) wl.addRow(row);
  wl.getColumn('amount').numFmt = MONEY;
  wl.autoFilter = { from: 'A1', to: { row: 1, column: lines.columns.length } };

  const raw = Buffer.from(await wb.xlsx.writeBuffer());
  const buffer = await fixSheetPrOrder(raw);
  const fileName = `${project?.project_code ?? 'Project'}_Actual_Cost_Register_${reportMonth || 'all'}.xlsx`;
  return { buffer, fileName };
}
