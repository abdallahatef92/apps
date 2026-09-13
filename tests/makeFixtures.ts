import ExcelJS from 'exceljs';

/**
 * Two fixtures shaped like the real thing: an SAP line-item actuals extract
 * (title block above the header, thousands separators, a parenthesised credit)
 * and a budget workbook.
 */
export async function makeActualsFile(path: string, dataDate: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('CJI3');

  ws.addRow(['Actual Cost Line Items']);
  ws.addRow(['Controlling Area', '1000']);
  ws.addRow([`Key date: ${dataDate}`]);
  ws.addRow([]);
  ws.addRow(['WBS Element', 'Object Name', 'Cost Element', 'Name of Account',
    'Posting Date', 'Document Number', 'Doc. Type', 'Name of offsetting account',
    'Quantity', 'UoM', 'Val/COArea Crcy', 'Currency', 'Posting Text']);

  const rows: unknown[][] = [
    ['P-100.CIV.01', 'Foundations', '600100', 'Subcontract civil', '2026-01-18', '5100001', 'RE', 'Al Rashid Contracting', 120, 'M3', '1,240,500.00', 'USD', 'Concrete pour zone A'],
    ['P-100.CIV.01', 'Foundations', '600100', 'Subcontract civil', '2026-02-11', '5100002', 'RE', 'Al Rashid Contracting', 80, 'M3', '820,000.00', 'USD', 'Concrete pour zone B'],
    ['P-100.CIV.01', 'Foundations', '400200', 'Cement & aggregates', '2026-02-20', '5100003', 'KR', 'Gulf Materials', 400, 'TON', '96,750.50', 'USD', 'Cement delivery'],
    ['P-100.MEC.01', 'Piping', '600200', 'Subcontract mechanical', '2026-02-28', '5100004', 'RE', 'Delta Mechanical', 1500, 'M', '2,105,000.00', 'USD', 'Pipe spool erection'],
    ['P-100.MEC.01', 'Piping', '400300', 'Pipe & fittings', '2026-03-05', '5100005', 'KR', 'SteelCo', 900, 'M', '740,200.00', 'USD', 'Carbon steel pipe'],
    ['P-100.MEC.01', 'Piping', '400300', 'Pipe & fittings', '2026-03-09', '5100006', 'KR', 'SteelCo', -20, 'M', '(16,450.00)', 'USD', 'Return of surplus pipe'],
    ['P-100.ELE.01', 'Electrical', '600300', 'Subcontract electrical', '2026-03-14', '5100007', 'RE', 'Voltech', 1, 'LS', '415,300.00', 'USD', 'Cable tray installation'],
    ['P-100.ELE.01', 'Electrical', '500100', 'Site labour', '2026-03-22', '5100008', 'SA', 'Internal payroll', 2400, 'HR', '187,600.00', 'USD', 'Direct labour March'],
    ['P-100.CIV.02', 'Structures', '600100', 'Subcontract civil', '2026-03-27', '5100009', 'RE', 'Al Rashid Contracting', 60, 'TON', '1,015,900.00', 'USD', 'Steel structure erection'],
    ['P-100.CIV.02', 'Structures', '600100', 'Subcontract civil', '2026-03-30', '5100010', 'RE', 'Al Rashid Contracting', 70, 'TON', '1,200,000.00', 'USD', 'Structure rework — variation order'],
  ];
  rows.forEach((r) => ws.addRow(r));
  await wb.xlsx.writeFile(path);
}

export async function makeBudgetFile(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Budget');
  ws.addRow(['Approved Budget — Rev 3']);
  ws.addRow([]);
  ws.addRow(['WBS Code', 'WBS Description', 'Discipline', 'Cost Element',
    'Cost Element Description', 'Quantity', 'Unit', 'Unit Rate', 'Budget Amount']);

  const rows: unknown[][] = [
    ['P-100.CIV.01', 'Foundations', 'Civil', '600100', 'Subcontract civil', 250, 'M3', 10000, 2500000],
    ['P-100.CIV.01', 'Foundations', 'Civil', '400200', 'Cement & aggregates', 900, 'TON', 250, 225000],
    ['P-100.CIV.02', 'Structures', 'Civil', '600100', 'Subcontract civil', 120, 'TON', 15000, 1800000],
    ['P-100.MEC.01', 'Piping', 'Mechanical', '600200', 'Subcontract mechanical', 3000, 'M', 1400, 4200000],
    ['P-100.MEC.01', 'Piping', 'Mechanical', '400300', 'Pipe & fittings', 3000, 'M', 550, 1650000],
    ['P-100.ELE.01', 'Electrical', 'Electrical', '600300', 'Subcontract electrical', 1, 'LS', 900000, 900000],
    ['P-100.ELE.01', 'Electrical', 'Electrical', '500100', 'Site labour', 12000, 'HR', 78, 936000],
  ];
  rows.forEach((r) => ws.addRow(r));
  await wb.xlsx.writeFile(path);
}
