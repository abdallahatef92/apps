# python3 recalc.py book.xlsx  -> recalculates in LibreOffice and prints the checks
import sys, os, subprocess, tempfile, shutil, openpyxl, warnings
fails = []
warnings.filterwarnings('ignore')
src = os.path.abspath(sys.argv[1]); d = tempfile.mkdtemp(); shutil.copy(src, d + '/b.xlsx')
subprocess.run(['soffice', '--headless', '--norestore', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', d + '/o', d + '/b.xlsx'], capture_output=True, timeout=900)
wb = openpyxl.load_workbook(d + '/o/b.xlsx', data_only=True)
def rowvals(ws, r): return [c.value for c in ws[r]]
for name in ['Service Monthly', 'Service Quarterly']:
    ws = wb[name]; r2 = rowvals(ws, 2); r1 = rowvals(ws, 1); r4 = rowvals(ws, 4)
    checks = [v for v in r2[11:] if v not in (None, '')]
    bad = [v for v in checks if v != '✔']
    print(f'{name}: {len(checks)} checks, not ✔: {bad[:8]} | header row4: {[v for v in r4 if v][:16]}')
    if bad or not checks: fails.append(name)
n = wb['Notes']
for r in range(32, 41): print('  Notes', n.cell(r, 1).value, '=', n.cell(r, 2).value)
d40 = n.cell(40, 2).value
if d40 is None or abs(d40) > 0.5: fails.append('Notes reconciliation')
pm = wb['Package Monthly']
for r in pm.iter_rows(min_row=2, values_only=True):
    if r[0] in ('Code', 'UNALLOCATED', 'TOTAL', 'DIV 03'): print('  PM', [v for v in r if v is not None][:6], '...', r[-2:])
db = wb['Dashboard']
for r in db.iter_rows(min_row=7, max_row=9, values_only=True): print('  tiles', [v for v in r if v not in (None, '')])
for r in db.iter_rows(values_only=True):
    if r[1] and str(r[1]).startswith('FINAL'): print('  ', r[2])
if 'Invoice Matrix' in wb.sheetnames:
    im = wb['Invoice Matrix']; nck = 0
    for row in im.iter_rows(values_only=True):
        a = str(row[0] or '')
        if a.startswith('Check'):
            vals = [v for v in row[3:] if v not in (None, '')]; nck += len(vals); bad = [v for v in vals if v != '✔']
            print(f'  IM {a}: {len(vals)} checks, not ✔: {bad[:8]}')
            if bad or not vals: fails.append('Invoice Matrix ' + a)
        if row[-1] is not None and (a in ('All invoices', 'In this report') or a.startswith('Excluded (')): print('  IM', a, '=', row[-1])
    print('  IM header', im.cell(2, 4).value)
    if not nck: fails.append('Invoice Matrix checks missing')
if fails: print('FAILED:', fails); sys.exit(1)
