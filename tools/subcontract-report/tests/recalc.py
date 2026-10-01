# python3 recalc.py book.xlsx  -> recalculates in LibreOffice and prints the checks
import sys, os, subprocess, tempfile, shutil, openpyxl, warnings
fails = []
warnings.filterwarnings('ignore')
src = os.path.abspath(sys.argv[1]); d = tempfile.mkdtemp(); shutil.copy(src, d + '/b.xlsx')
subprocess.run(['soffice', '--headless', '--norestore', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', d + '/o', d + '/b.xlsx'], capture_output=True, timeout=900)
wb = openpyxl.load_workbook(d + '/o/b.xlsx', data_only=True)
def rowvals(ws, r): return [c.value for c in ws[r]]
for name in [n for n in ['Service Monthly', 'Rolling Monthly', 'Service Quarterly'] if n in wb.sheetnames]:
    ws = wb[name]; r2 = rowvals(ws, 2); r1 = rowvals(ws, 1); r4 = rowvals(ws, 4)
    checks = [v for v in r2[11:] if v not in (None, '')]
    bad = [v for v in checks if v != '✔']
    print(f'{name}: {len(checks)} checks, not ✔: {bad[:8]} | header row4: {[v for v in r4 if v][:16]}')
    if bad or not checks: fails.append(name)
for name in ['Service Monthly', 'Service Quarterly']:
    ws = wb[name]; h = [c.value for c in ws[5]]
    if 'Trade' not in h: fails.append(name + ' has no Trade column'); continue
    tc = h.index('Trade') + 1; rows = [r for r in range(6, ws.max_row + 1) if ws.cell(r, 1).value]
    bad = [ws.cell(r, tc).value for r in rows if ws.cell(r, tc).value in (None, '', 'UNMAPPED')]
    print(f'  {name} Trade: {len(rows)} rows, {len(set(ws.cell(r, tc).value for r in rows))} trades, unmapped {len(bad)}')
    if bad: fails.append(name + ' Trade unmapped')
n = wb['Notes']
for r in range(32, 41): print('  Notes', n.cell(r, 1).value, '=', n.cell(r, 2).value)
d40 = n.cell(40, 2).value
if d40 is None or abs(d40) > 0.5: fails.append('Notes reconciliation')
pm = wb['DIV Monthly'] if 'DIV Monthly' in wb.sheetnames else wb['Package Monthly']
for r in pm.iter_rows(min_row=2, values_only=True):
    if r[0] in ('Code', 'DIV', 'UNALLOCATED', 'TOTAL', 'DIV 03'): print('  PM', [v for v in r if v is not None][:6], '...', r[-2:])
db = wb['Dashboard']
for r in db.iter_rows(min_row=7, max_row=9, values_only=True): print('  tiles', [v for v in r if v not in (None, '')])
for r in db.iter_rows(values_only=True):
    if r[1] and str(r[1]).startswith('FINAL'): print('  ', r[2])
if 'PO Register' in wb.sheetnames:
    pr = wb['PO Register']; h = [c.value for c in pr[1]]
    if 'Row' in h:
        rows = list(pr.iter_rows(min_row=2, values_only=True)); ck = next((r for r in rows if str(r[0] or '').startswith('Check')), None)
        tot = next(r for r in rows if r[0] == 'Total'); ti = h.index('Total (excl VAT)')
        vals = [v for v in (ck or [])[1:] if v not in (None, '')]; bad = [v for v in vals if v != '✔']
        npo = sum(1 for r in rows if r[1] == 'PO'); nsv = sum(1 for r in rows if r[1] == 'Service')
        coded = sum(1 for r in rows if r[1] == 'Service' and r[h.index('DIV')])
        print(f'  PO Register: {npo} POs, {nsv} service rows ({coded} with a DIV), total {tot[ti]:,.2f}, checks {len(vals)} not ✔ {bad}')
        if bad or not vals: fails.append('PO Register services vs POs')
        if abs((tot[ti] or 0) - (n.cell(35, 2).value or 0)) > 0.5: fails.append('PO Register total vs Detail')
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
if 'Rolling Monthly' in wb.sheetnames:
    rm = wb['Rolling Monthly']; r1, r4 = rowvals(rm, 1), rowvals(rm, 4)
    blk = {v: i for i, v in enumerate(r4) if v}
    amt = lambda lab: r1[blk[lab] + 2] if lab in blk else None
    itd = r1[blk['ITD (to date)'] + 3]; ytd = next(amt(k) for k in blk if str(k).startswith('YTD'))
    months = sum(r1[i + 2] or 0 for k, i in blk.items() if k not in ('Opening', 'B/F prior years', 'ITD (to date)', 'Pending – not in Total', 'Reference') and not str(k).startswith('YTD') and not str(k).startswith('After'))
    print(f'  Rolling: Opening {amt("Opening"):,.0f} · B/F {amt("B/F prior years"):,.0f} · YTD {ytd:,.0f} (months {months:,.0f}) · ITD {itd:,.0f} · Pending {amt("Pending – not in Total"):,.0f}')
    if abs(itd - (amt('Opening') + amt('B/F prior years') + ytd + (amt('After Dec (included)') or 0))) > 0.5 or abs(months - ytd) > 0.5: fails.append('Rolling ITD = Opening + B/F + YTD')
    if abs(itd + amt('Pending – not in Total') - (n.cell(35, 2).value or 0)) > 0.5: fails.append('Rolling ITD + Pending = Detail')
if fails: print('FAILED:', fails); sys.exit(1)
