// Invoice Matrix: one cell per invoice (PO + Invoice Serial), by subcontractor / PO and month, coloured live from Detail
const E = require('../engine.js'), X = require('xlsx'), ExcelJS = require('exceljs'), JSZip = require('jszip'), assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
// real extracts are never committed: point SUBCON_PROG / SUBCON_SERV at the TRAZ ZSCPRG01 / ZSCSRV1 exports
const PROG = process.env.SUBCON_PROG, SERV = process.env.SUBCON_SERV;
if (!PROG || !SERV) { console.log('SKIPPED – set SUBCON_PROG and SUBCON_SERV to the TRAZ ZSCPRG01 and ZSCSRV1 exports'); process.exit(0); }
const rd = (f) => { const w = X.readFile(f); return X.utils.sheet_to_json(w.Sheets[w.SheetNames[0]], { header: 1, raw: true, defval: '' }); };
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 0.01, `${m}: ${a} ≠ ${b}`);
(async () => {
  const prog = rd(PROG), serv = rd(SERV);
  const A = E.analyse(prog, serv, { cutMonth: 202608, files: { prog: 'traz' } });
  // an invoice is one date and one approval in SAP – the matrix colours the whole invoice on that basis
  const inv = new Map(); for (const r of A.det) { const k = r.po + '|' + r.serial, v = inv.get(k) || { m: new Set(), a: new Set(), amt: 0, r }; v.m.add(r.month); v.a.add(r.approved); v.amt += r.amt; inv.set(k, v); }
  assert.strictEqual(inv.size, 361, 'invoices');
  assert.ok([...inv.values()].every((v) => v.m.size === 1 && v.a.size === 1), 'every invoice has one month and one approval');
  const na = [...inv.values()].filter((v) => !v.r.approved); assert.strictEqual(na.length, 8, 'not-approved invoices');
  near(na.reduce((s, v) => s + v.amt, 0), E.summarize(A).k.notApproved, 'not-approved invoices = not-approved lines');
  const buf = Buffer.from(await E.buildWorkbook(A, { ExcelJS, JSZip }));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); const im = wb.getWorksheet('Invoice Matrix');
  assert.strictEqual(wb.worksheets[1].name, 'Invoice Matrix', 'second tab, after the Dashboard');
  const h = im.getRow(4).values, ic = [], ac = []; h.forEach((v, c) => { if (v === 'Invoice') ic.push(c); if (v === 'Amount') ac.push(c); });
  assert.strictEqual(ic.length, ac.length); assert.ok(ic.every((c, j) => ac[j] === c + 1), 'invoice / amount pairs');
  let n = 0, sum = 0, r = 5; const seen = new Set();
  for (; im.getCell(r, 3).value; r++) ic.forEach((c) => { const s = im.getCell(r, c).value; if (!s) return; n++; sum += im.getCell(r, c + 1).value;
    const k = im.getCell(r, 3).value + '|' + s; assert.ok(!seen.has(k), 'invoice shown once: ' + k); seen.add(k); assert.ok(inv.has(k), 'known invoice ' + k); });
  assert.strictEqual(n, 361, 'every invoice in the matrix'); near(sum, 73923142.32, 'matrix = SAP grand total');
  // each invoice sits in its own month column (Opening for initial invoices)
  const lab = (m) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m % 100 - 1] + '-' + String(Math.floor(m / 100)).slice(2);
  for (let i = 5; i < r; i++) ic.forEach((c) => { const s = im.getCell(i, c).value; if (!s) return; const v = inv.get(im.getCell(i, 3).value + '|' + s), top = String(im.getCell(3, c).value);
    assert.ok(v.r.initial ? top === 'Opening' : top.startsWith(lab(v.r.month)), `${s} under ${top}`); });
  // excluded list: not approved first, then after the cut date – together exactly the Pending total
  let x = r; while (im.getCell(x, 8).value !== 'Status') x++;
  const ex = []; for (let i = x + 1; im.getCell(i, 4).value; i++) ex.push({ inv: im.getCell(i, 4).value, amt: im.getCell(i, 7).value, f: im.getCell(i, 8).value.formula });
  assert.strictEqual(ex.length, 26, '8 not approved + 18 after the cut date');
  near(ex.reduce((s, v) => s + v.amt, 0), 3064142.07, 'excluded list = Pending');
  near(ex.slice(0, 8).reduce((s, v) => s + v.amt, 0), 1338130.91, 'not approved first');
  assert.ok(ex.every((v) => /COUNTIFS\(IM_PO/.test(v.f)), 'status reads Detail live');
  // live colour: three rules per month column on Detail through defined names
  const cf = im.conditionalFormattings; assert.strictEqual(cf.length, ic.length + 1);
  assert.ok(cf.slice(0, -1).every((f) => f.rules.length === 3 && /IM_APPR,"<>X"/.test(f.rules[0].formulae[0]) && /IM_BKT,"PENDING"/.test(f.rules[1].formulae[0])), 'red / grey / green');
  // Excel applies a lower rule number first only when every rule on the sheet has its own number; red / grey stop the green
  { const z = await JSZip.loadAsync(buf), wbx = await z.file('xl/workbook.xml').async('string');
    const idx = [...wbx.matchAll(/<sheet [^>]*name="([^"]+)"/g)].findIndex((m) => m[1] === 'Invoice Matrix') + 1;
    const x = await z.file(`xl/worksheets/sheet${idx}.xml`).async('string'), pr = [...x.matchAll(/<cfRule [^>]*priority="(\d+)"/g)].map((m) => m[1]);
    assert.strictEqual(new Set(pr).size, pr.length, 'unique rule priorities');
    assert.strictEqual((x.match(/stopIfTrue="1"/g) || []).length, 2 * ic.length, 'red and grey stop the green rule');
    const blk = x.match(/<conditionalFormatting sqref="[A-Z]+5:[A-Z]+\d+">(.*?)<\/conditionalFormatting>/)[1];
    assert.ok(/IM_APPR/.test(blk.split('</cfRule>')[0]) && /stopIfTrue="1"/.test(blk.split('</cfRule>')[0]), 'red rule first in each column'); }
  if (require('child_process').spawnSync('which', ['soffice']).status === 0) {
    const tmp = path.join(os.tmpdir(), 'imtest.xlsx'); fs.writeFileSync(tmp, buf);
    const rc = require('child_process').spawnSync('python3', [path.join(__dirname, 'recalc.py'), tmp], { encoding: 'utf8', timeout: 900000 });
    assert.strictEqual(rc.status, 0, rc.stdout + rc.stderr); console.log(rc.stdout.split('\n').filter((l) => l.includes('IM')).join('\n'));
    // Include every after-cut line: the grey invoices turn in, nothing left excluded but the not-approved 8
    const inc = require('child_process').spawnSync('python3', [path.join(__dirname, 'include_check.py'), tmp, String(A.det.filter((r) => r.approved && !r.initial && r.month > 202608).reduce((s, r) => s + r.amt, 0)), String(E.summarize(A).k.notApproved)], { encoding: 'utf8', timeout: 900000 });
    assert.strictEqual(inc.status, 0, inc.stdout + inc.stderr); console.log(inc.stdout.trim());
  } else console.log('(LibreOffice not installed – recalculation skipped)');
  console.log('imtest ok');
})().catch((e) => { console.error(e); process.exit(1); });
