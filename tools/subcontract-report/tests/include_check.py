# python3 include_check.py report.xlsx expected_sep_block expected_pending
# Picks "Include" on every after-cut line of Detail, recalculates in LibreOffice and checks that the lines left Pending for their month.
import sys, openpyxl, subprocess, tempfile, shutil, warnings
warnings.filterwarnings('ignore')
src, exp_month, exp_pend = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
d = tempfile.mkdtemp(); wb = openpyxl.load_workbook(src); dt = wb['Detail']
h = [c.value for c in dt[1]]; ic = h.index('Include in this report') + 1
n = sum(1 for r in range(2, dt.max_row + 1) if dt.cell(r, ic).value == 'Not included')
for r in range(2, dt.max_row + 1):
    if dt.cell(r, ic).value == 'Not included': dt.cell(r, ic).value = 'Include'
wb.save(d + '/b.xlsx')
subprocess.run(['soffice', '--headless', '--norestore', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', d + '/o', d + '/b.xlsx'], capture_output=True, timeout=900)
w = openpyxl.load_workbook(d + '/o/b.xlsx', data_only=True); sm = w['Service Monthly']
r1, r2, r4 = [c.value for c in sm[1]], [c.value for c in sm[2]], [c.value for c in sm[4]]
after = [i for i, v in enumerate(r4) if isinstance(v, str) and v.endswith('after cut')]
got_month = sum(r1[i + 2] or 0 for i in after); pend = r1[r4.index('Pending – not in Total') + 2]
bad = [v for v in r2[11:] if v not in (None, '', '✔')]; diff = w['Notes'].cell(40, 2).value
print(f'included {n} lines · after-cut blocks {got_month:,.2f} · pending {pend:,.2f} · checks not ✔ {bad} · notes difference {diff}')
ok = n > 0 and abs(got_month - exp_month) < 0.01 and abs(pend - exp_pend) < 0.01 and not bad and diff is not None and abs(diff) < 0.5
sys.exit(0 if ok else 1)
