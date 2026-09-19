import ExcelJS from 'exceljs';

/**
 * Fixtures shaped like the real thing. Cost element codes follow the usual SAP
 * operating chart (3xxxxxxx expense, 4xxxxxxx income) because the classification
 * rules depend on it.
 *
 * The first two: an SAP line-item actuals extract
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
    ['P-100.CIV.01', 'Foundations', '30501100', 'Subcontract civil', '2026-01-18', '5100001', 'RE', 'Al Rashid Contracting', 120, 'M3', '1,240,500.00', 'USD', 'Concrete pour zone A'],
    ['P-100.CIV.01', 'Foundations', '30501100', 'Subcontract civil', '2026-02-11', '5100002', 'RE', 'Al Rashid Contracting', 80, 'M3', '820,000.00', 'USD', 'Concrete pour zone B'],
    ['P-100.CIV.01', 'Foundations', '30201100', 'Cement & aggregates', '2026-02-20', '5100003', 'KR', 'Gulf Materials', 400, 'TON', '96,750.50', 'USD', 'Cement delivery'],
    ['P-100.MEC.01', 'Piping', '30501200', 'Subcontract mechanical', '2026-02-28', '5100004', 'RE', 'Delta Mechanical', 1500, 'M', '2,105,000.00', 'USD', 'Pipe spool erection'],
    ['P-100.MEC.01', 'Piping', '30201200', 'Pipe & fittings', '2026-03-05', '5100005', 'KR', 'SteelCo', 900, 'M', '740,200.00', 'USD', 'Carbon steel pipe'],
    ['P-100.MEC.01', 'Piping', '30201200', 'Pipe & fittings', '2026-03-09', '5100006', 'KR', 'SteelCo', -20, 'M', '(16,450.00)', 'USD', 'Return of surplus pipe'],
    ['P-100.ELE.01', 'Electrical', '30501300', 'Subcontract electrical', '2026-03-14', '5100007', 'RE', 'Voltech', 1, 'LS', '415,300.00', 'USD', 'Cable tray installation'],
    ['P-100.ELE.01', 'Electrical', '30301100', 'Site labour', '2026-03-22', '5100008', 'SA', 'Internal payroll', 2400, 'HR', '187,600.00', 'USD', 'Direct labour March'],
    ['P-100.CIV.02', 'Structures', '30501100', 'Subcontract civil', '2026-03-27', '5100009', 'RE', 'Al Rashid Contracting', 60, 'TON', '1,015,900.00', 'USD', 'Steel structure erection'],
    ['P-100.CIV.02', 'Structures', '30501100', 'Subcontract civil', '2026-03-30', '5100010', 'RE', 'Al Rashid Contracting', 70, 'TON', '1,200,000.00', 'USD', 'Structure rework — variation order'],
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
    ['P-100.CIV.01', 'Foundations', 'Civil', '30501100', 'Subcontract civil', 250, 'M3', 10000, 2500000],
    ['P-100.CIV.01', 'Foundations', 'Civil', '30201100', 'Cement & aggregates', 900, 'TON', 250, 225000],
    ['P-100.CIV.02', 'Structures', 'Civil', '30501100', 'Subcontract civil', 120, 'TON', 15000, 1800000],
    ['P-100.MEC.01', 'Piping', 'Mechanical', '30501200', 'Subcontract mechanical', 3000, 'M', 1400, 4200000],
    ['P-100.MEC.01', 'Piping', 'Mechanical', '30201200', 'Pipe & fittings', 3000, 'M', 550, 1650000],
    ['P-100.ELE.01', 'Electrical', 'Electrical', '30501300', 'Subcontract electrical', 1, 'LS', 900000, 900000],
    ['P-100.ELE.01', 'Electrical', 'Electrical', '30301100', 'Site labour', 12000, 'HR', 78, 936000],
  ];
  rows.forEach((r) => ws.addRow(r));
  await wb.xlsx.writeFile(path);
}

/**
 * A CJI3-shaped extract carrying the three traps a real SAP export contains:
 *
 *  - subtotal rows interleaved with detail (blank Document Number), which would
 *    double-count if loaded;
 *  - income postings on a 4xxxxxxx account as negative amounts, which would
 *    silently net down actual cost;
 *  - a purchase order on the subcontract lines, linking them to service detail.
 *
 * `onlyMonths` cuts the export down to selected months, the way a cost engineer
 * splits a large extract before loading it.
 */
export async function makeCji3File(
  path: string,
  options: { onlyMonths?: string[] } = {},
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');

  ws.addRow(['Cost Element', 'Cost element name', 'Material', 'Material Description',
    'WBS Element', 'Project definition',
    'Object', 'Posting Date', 'Document Number', 'Posting Row', 'Fiscal Year',
    'Document Type', 'Purchasing Document', 'Offsetting Account',
    'Name of offsetting account', 'Object Type',
    'Total quantity', 'Posted unit of meas.', 'Val/COArea Crcy', 'CO area currency']);

  // month tag, then the row itself. Two lines share document D2 to prove the
  // posting row is what separates them, exactly as it does in a real export.
  // Only the material-cost-type rows (D3/D4) carry a real Material — a
  // subcontract/labour/income CO line typically has none, exactly like a
  // genuine CJI3 export.
  const detail: [string, unknown[]][] = [
    ['2026-01', ['30501100', 'Subcontractor Cost', '', '', 'P-100.CIV.01', 'P-100', 'P-100.CIV.01',
      '2026-01-18', 'D1', 1, '2026', 'SC', '4500001', 'V001', 'Al Rashid Contracting', 'WBS',
      40, 'M3', 1000000, 'EGP']],
    ['2026-02', ['30501100', 'Subcontractor Cost', '', '', 'P-100.CIV.01', 'P-100', 'P-100.CIV.01',
      '2026-02-11', 'D2', 1, '2026', 'SC', '4500001', 'V001', 'Al Rashid Contracting', 'WBS',
      20, 'M3', 300000, 'EGP']],
    ['2026-02', ['30501100', 'Subcontractor Cost', '', '', 'P-100.CIV.01', 'P-100', 'P-100.CIV.01',
      '2026-02-11', 'D2', 2, '2026', 'SC', '4500001', 'V001', 'Al Rashid Contracting', 'WBS',
      10, 'M3', 200000, 'EGP']],
    ['2026-02', ['30201100', 'Main Material', 'MAT-CEM-01', 'Portland Cement 42.5N',
      'P-100.MEC.01', 'P-100', 'P-100.MEC.01',
      '2026-02-20', 'D3', 1, '2026', 'WA', '', 'V002', 'Gulf Materials', 'WBS',
      300, 'TON', 250000, 'EGP']],
    ['2026-03', ['30201100', 'Main Material', 'MAT-CEM-01', 'Portland Cement 42.5N',
      'P-100.MEC.01', 'P-100', 'P-100.MEC.01',
      '2026-03-05', 'D4', 1, '2026', 'WA', '', 'V002', 'Gulf Materials', 'WBS',
      -60, 'TON', -50000, 'EGP']],
    ['2026-03', ['40101100', 'Op contracts Income', '', '', 'P-100.CIV.01', 'P-100', 'P-100.CIV.01',
      '2026-03-31', 'R1', 1, '2026', 'RV', '', 'C001', 'Client billing', 'WBS',
      0, '', -1200000, 'EGP']],
  ];

  const wanted = options.onlyMonths
    ? detail.filter(([m]) => options.onlyMonths!.includes(m))
    : detail;

  const blank = (ce: string, amount: number) =>
    [ce, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', amount, 'EGP'];

  // A full export prints grand totals and per-cost-element subtotals between the
  // detail; a hand-cut subset normally does not.
  if (!options.onlyMonths) {
    ws.addRow(blank('', 500000));
    ws.addRow(blank('30501100', 1500000));
    ws.addRow(wanted[0][1]);
    ws.addRow(wanted[1][1]);
    ws.addRow(wanted[2][1]);
    ws.addRow(blank('30201100', 200000));
    ws.addRow(wanted[3][1]);
    ws.addRow(wanted[4][1]);
    ws.addRow(blank('40101100', -1200000));
    ws.addRow(wanted[5][1]);
  } else {
    for (const [, row] of wanted) ws.addRow(row);
  }

  await wb.xlsx.writeFile(path);
}

/** Service lines beneath PO 4500001, reconciling exactly to its actual postings. */
export async function makeSubcontractorFile(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');

  ws.addRow(['Profit Ctr', 'Invoice Serial (new)', 'Date', 'Pur. Doc.',
    'Account Number of Supplier', 'Supplier', 'DocumentNo', 'Entry Sh.', 'Item', 'Line',
    'Gross Price', 'Crcy', 'Service', 'Short Text 1', 'Total Quantity', 'BUn',
    'Previous Quantity', 'Current Quantity', 'Progress %', 'VAT Current',
    'SC Work Current Cost', 'SC Work Current + Vat', 'G/L Acct', 'WBS Element', 'Description']);

  ws.addRow(['P-100', 'C1', '2026-01-18', '4500001', 'Al Rashid Contracting', 'V001',
    '5100001', '1000001', 10, 1, 25000, 'EGP', 'S0302', 'Concrete pour zone A',
    40, 'M3', 0, 40, 100, 140000, 1000000, 1140000, '30501100', 'P-100.CIV.01', 'DIV03 - CONCRETE']);
  ws.addRow(['', 'C1 (1)', '', '', '', '', '', '', '', '', '', '', '', '',
    40, '', 0, 40, 100, 140000, 1000000, 1140000, '', '', '']);
  ws.addRow(['P-100', 'C2', '2026-02-11', '4500001', 'Al Rashid Contracting', 'V001',
    '5100002', '1000002', 10, 1, 25000, 'EGP', 'S0302', 'Concrete pour zone B',
    60, 'M3', 40, 20, 100, 70000, 500000, 570000, '30501100', 'P-100.CIV.01', 'DIV03 - CONCRETE']);
  ws.addRow(['', 'C2 (1)', '', '', '', '', '', '', '', '', '', '', '', '',
    60, '', 40, 20, 100, 70000, 500000, 570000, '', '', '']);

  await wb.xlsx.writeFile(path);
}

/**
 * A project structure export. Note the SAP caption trap this reproduces: "Title"
 * carries the WBS code and "Description" carries its name, and the root is
 * repeated at level 00 and 01.
 */
export async function makeWbsTreeFile(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['.', 'Level', 'Description', 'Title', 'Start date', 'Basic fin.', 'Act. start', 'Actual End']);

  const rows: unknown[][] = [
    [1, '00', 'Test Plant', 'P-100', '2026-01-01', '2026-12-31', '2026-01-05', ''],
    [2, '01', 'Test Plant', 'P-100', '2026-01-01', '2026-12-31', '2026-01-05', ''],
    [3, '02', 'Civil works', 'P-100.CIV', '2026-01-01', '2026-06-30', '2026-01-05', ''],
    [4, '03', 'Foundations', 'P-100.CIV.01', '2026-01-01', '2026-03-31', '2026-01-05', '2026-03-28'],
    [5, '03', 'Structures', 'P-100.CIV.02', '2026-02-01', '2026-06-30', '', ''],
    [6, '02', 'Mechanical works', 'P-100.MEC', '2026-02-01', '2026-09-30', '2026-02-10', ''],
    [7, '03', 'Piping', 'P-100.MEC.01', '2026-02-01', '2026-08-31', '2026-02-10', ''],
    [8, '02', 'Electrical works', 'P-100.ELE', '2026-03-01', '2026-10-31', '', ''],
    [9, '03', 'Electrical', 'P-100.ELE.01', '2026-03-01', '2026-10-31', '', ''],
  ];
  rows.forEach((r) => ws.addRow(r));
  await wb.xlsx.writeFile(path);
}
