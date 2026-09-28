'use strict';
/* Material Cost Report – page. All numbers come from MaterialEngine; this file reads files, renders and codes. */
const E = window.MaterialEngine;
const $ = (id) => document.getElementById(id);
const esc = E.esc;
const state = { files: {}, names: {}, prev: null, prevName: null, master: null, masterName: null, A: null, charts: {}, sel: { mat: null, price: null }, codeLimit: 300, codeRows: [] };
const LS = { coding: 'mcr.coding.v1', theme: 'mcr-theme', folded: 'mcr.folded' };
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window: the page still works, coding lives in the report */ } };

// ------------------------------------------------------------------ number formats
const n0 = (v) => (v === null || v === undefined || v === '') ? '' : (Math.round(v) === 0 ? '0' : Math.round(v).toLocaleString('en-US'));
const n2 = (v) => (v === null || v === undefined || v === '') ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nq = (v) => (v === null || v === undefined || v === '' || Math.abs(v) < 1e-9) ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 });
const pc = (v) => (v === null || v === undefined || !isFinite(v)) ? '' : (v * 100).toFixed(1) + '%';
const mEGP = (v) => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(Math.abs(v) >= 1e8 ? 0 : 1) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : n0(v);
const td = (v, cls) => `<td class="${cls || ''}">${v}</td>`;
const tdn = (v, f) => `<td class="r num${typeof v === 'number' && v < -1e-9 ? ' neg' : ''}">${(f || n0)(v)}</td>`;

// ------------------------------------------------------------------ theme and layout
function themeNow() { const t = document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function themeLabel() { const b = $('btn-theme'), dark = themeNow() === 'dark'; b.textContent = dark ? '☀️ Light mode' : '🌙 Dark mode'; b.setAttribute('aria-pressed', dark); }
{ const t = lsGet(LS.theme, null); if (t) document.documentElement.dataset.theme = t; }
$('btn-theme').addEventListener('click', () => { const t = themeNow() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; lsSet(LS.theme, t); themeLabel(); if (state.A) renderCharts(); });
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { themeLabel(); if (state.A) renderCharts(); }); } catch (e) { /* old browser */ }
themeLabel();
function setFold(f) { $('layout').classList.toggle('folded', f); $('wrap').classList.toggle('wide', f); $('btn-fold').setAttribute('aria-expanded', String(!f)); $('btn-unfold').setAttribute('aria-expanded', String(!f)); lsSet(LS.folded, f); }
$('btn-fold').addEventListener('click', () => setFold(true)); $('btn-unfold').addEventListener('click', () => setFold(false));
{ const ok = typeof XLSX !== 'undefined' && typeof ExcelJS !== 'undefined' && typeof Chart !== 'undefined' && typeof JSZip !== 'undefined';
  $('dot-libs').className = 'dot ' + (ok ? 'on' : 'off'); $('txt-libs').textContent = ok ? 'Ready · works offline' : 'Libraries missing – rebuild the page'; }

// ------------------------------------------------------------------ messages / status
function message(host, kind, html) { const d = document.createElement('div'); d.className = 'msg ' + kind; d.innerHTML = html; $(host).appendChild(d); }
function status(t, p) { $('status').textContent = t || ''; $('prog').hidden = p === undefined; if (p !== undefined) $('prog-bar').style.width = Math.round(p * 100) + '%'; }
const tick = () => new Promise((r) => setTimeout(r, 20));

// ------------------------------------------------------------------ reading files
const KIND_TAG = { me: 'ME2N', mb: 'MB51', cji: 'CJI3' };
async function readBook(file) {
  const buf = await file.arrayBuffer();
  return XLSX.read(buf, { type: 'array', cellDates: false, dense: true });   // raw serials: dates and entry times never shift with the PC's time zone
}
const aoaOf = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
function setSlot(k, name, meta, ok) { $('name-' + k).textContent = name; $('meta-' + k).textContent = meta; $('slot-' + k).classList.toggle('ok', ok !== false); }
async function takeFiles(list) {
  $('msgs').innerHTML = '';
  const files = [...list];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]; status(`Reading ${f.name}…`, i / files.length); await tick();
    let wb; try { wb = await readBook(f); } catch (e) { message('msgs', 'bad', `${esc(f.name)} could not be read: ${esc(e.message)}`); continue; }
    const names = wb.SheetNames;
    if (names.includes('_Meta') || names.includes('Material Coding')) {         // a previous material report
      const aoa = {}; for (const n of ['_Meta', 'Material Coding', 'Load history', '_Snap', '_POs', '_Rows', '_Months']) if (wb.Sheets[n]) aoa[n] = aoaOf(wb.Sheets[n]);
      const P = E.readPrevious(aoa);
      if (!P) { message('msgs', 'warn', `${esc(f.name)} looks like a report but has no coding or history in it.`); continue; }
      state.prev = P; state.prevName = f.name;
      setSlot('prev', f.name, P.meta.reportMonth ? `${E.mlabel(P.meta.reportMonth)} report · cut-off ${E.tsText(P.meta.cutoff) || 'none'} · ${P.coding.size} coded materials` : `Load ${P.meta.loadNo || '?'} · ${P.coding.size} coded materials (no cut-off recorded)`);
      continue;
    }
    if (names.includes('Packages') && (names.includes('Service Mapping') || names.includes('MNL'))) {   // the subcontract work package master
      const m = readMasterLists(wb); state.master = m; state.masterName = f.name;
      setSlot('master', f.name, `${m.packages.length} packages · ${m.mnl.length} MNL codes`); continue;
    }
    let hit = false;
    for (const n of names) { const aoa = aoaOf(wb.Sheets[n]); const k = E.detectKind(aoa);
      if (!k) continue; hit = true;
      state.files[k] = aoa; state.names[k] = f.name;
      const rows = aoa.length - 1;
      setSlot(k, f.name, `${rows.toLocaleString('en-US')} rows${n !== 'Sheet1' && n !== 'Data' ? ' · sheet ' + n : ''}`); break; }
    if (!hit) message('msgs', 'warn', `${esc(f.name)} is not an ME2N, MB51 or CJI3 export, a material report or a work package master – its columns were not recognised.`);
  }
  status('');
  const ready = ['me', 'mb', 'cji'].every((k) => state.files[k]);
  $('btn-clear').disabled = !Object.keys(state.files).length && !state.prev;
  if (ready) setupPeriod(); else { $('period').hidden = true; state.period = null; }
  updateBuild();
  if (!ready) status('Still needed: ' + ['me', 'mb', 'cji'].filter((k) => !state.files[k]).map((k) => KIND_TAG[k]).join(', '));
  else if (state.A && cutoffValue() !== null) build();   // swapping one file rebuilds straight away
}
function readMasterLists(wb) {
  const rows = (n) => { const a = wb.Sheets[n] ? aoaOf(wb.Sheets[n]) : []; const h = (a[0] || []).map((x) => E.str(x)); return a.slice(1).map((r) => Object.fromEntries(h.map((k, j) => [k, r[j]]))); };
  const packages = rows('Packages').filter((r) => E.str(r.Code)).map((r, i) => ({ code: E.normPkg(r.Code), label: E.str(r.Label) || E.str(r.Code), group: E.str(r.Group) || 'General', sort: i + 1 }));
  const mnl = rows('MNL').filter((r) => E.str(r.Code)).map((r) => ({ code: E.str(r.Code), label: E.str(r.Label) || E.str(r.Code) }));
  return { packages: packages.length ? packages : E.PACKAGES, mnl: mnl.length ? mnl : E.MNLS };
}
$('drop').addEventListener('click', () => $('file').click());
$('drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('file').addEventListener('change', (e) => { takeFiles(e.target.files); e.target.value = ''; });
for (const ev of ['dragenter', 'dragover']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); });
$('drop').addEventListener('drop', (e) => takeFiles(e.dataTransfer.files));
$('btn-clear').addEventListener('click', () => {
  state.files = {}; state.names = {}; state.prev = null; state.A = null; state.master = null;
  for (const [k, t] of [['me', 'Purchase orders — required'], ['mb', 'Material movements — required'], ['cji', 'Actual cost — required'], ['prev', "Last month's report — optional"], ['master', 'Work package master — optional']])
    { $('name-' + k).textContent = t; $('slot-' + k).classList.remove('ok'); }
  $('meta-me').textContent = 'Material group, PO prices, open quantities'; $('meta-mb').textContent = 'Receipts, issues, transfers, stock';
  $('meta-cji').textContent = 'Goods issues (WA) on the project WBS'; $('meta-prev').textContent = 'Brings coding, load history and changes forward';
  $('meta-master').textContent = 'Package and MNL lists shared with the subcontract report';
  $('period').hidden = true; state.period = null;
  $('results').hidden = true; $('empty').hidden = false; $('btn-build').disabled = true; $('btn-clear').disabled = true; $('msgs').innerHTML = ''; status('');
});

// ------------------------------------------------------------------ coding store
// Browser store per plant: {material: {package, mnl, cec, t}}. The previous report's codes win unless the browser's
// entry was changed after that report was saved.
function storeAll() { return lsGet(LS.coding, {}); }
function codingFor(plant) {
  const local = storeAll()[plant] || {}, out = new Map();
  const saved = state.prev && state.prev.meta.saved ? Date.parse(state.prev.meta.saved) : 0;
  if (state.prev && (!state.prev.project || state.prev.project === plant)) for (const [m, v] of state.prev.coding) out.set(m, { ...v });
  for (const [m, v] of Object.entries(local)) if (!out.has(m) || (v.t || 0) > saved) out.set(m, { package: v.package || '', mnl: v.mnl || '', cec: v.cec || '' });
  return out;
}
function saveCode(plant, material, patch) {
  const all = storeAll(); all[plant] = all[plant] || {};
  const cur = Object.assign({ package: '', mnl: '', cec: '' }, state.coding.get(material) || {}, patch);
  all[plant][material] = { ...cur, t: Date.now() }; lsSet(LS.coding, all);
  state.coding.set(material, { package: cur.package, mnl: cur.mnl, cec: cur.cec });
}

// ------------------------------------------------------------------ build
$('btn-build').addEventListener('click', build);
async function build() {
  status('Tying cost to movements…', 0.5); await tick();
  const plant = guessPlant();
  state.plant = plant; state.coding = codingFor(plant);
  const A = analyse();
  if (A.errors) { status(''); $('msgs').innerHTML = ''; A.errors.forEach((e) => message('msgs', 'bad', esc(e))); return; }
  state.A = A;
  if (state.prev && state.prev.project && state.prev.project !== plant)
    message('msgs', 'warn', `The last report is for ${esc(state.prev.project)}, but these files are for ${esc(plant)}. Its coding and changes were not used.`);
  status(''); $('empty').hidden = true; $('results').hidden = false;
  renderAll();
}
const prevFits = () => state.prev && (!state.prev.project || state.prev.project === state.plant);
function analyse() {
  const prev = prevFits() ? state.prev : null;
  return E.analyse(state.files, { coding: state.coding, prev, history: prev ? prev.loads : [],
    reportMonth: +$('p-month').value || undefined, cutoff: cutoffValue(), openingBefore: +$('p-open').value || 0,
    packages: state.master ? state.master.packages : undefined, mnl: state.master ? state.master.mnl : undefined,
    files: { me: state.names.me, mb: state.names.mb, cji: state.names.cji } });
}
function guessPlant() { const mb = state.files.mb; if (!mb) return ''; const h = (mb[0] || []).map(E.str), i = h.indexOf('Plant'); return i >= 0 && mb[1] ? E.str(mb[1][i]) : ''; }
function recode() {                                // coding changed: re-run the (fast) analysis, keep the coding table as it is
  const keepScroll = window.scrollY; state.A = analyse(); renderOverview(); renderMaterials(); renderCodingSummary(); setCodingPill(); window.scrollTo(0, keepScroll);
}

// ------------------------------------------------------------------ tabs
const TABS = ['overview', 'materials', 'price', 'changes', 'coding', 'checks'];
function selectTab(name) { for (const t of TABS) { const on = t === name; $('tab-' + t).setAttribute('aria-selected', on); $('view-' + t).hidden = !on; } }
for (const t of TABS) $('tab-' + t).addEventListener('click', () => selectTab(t));
$('results').querySelector('[role=tablist]').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const i = TABS.findIndex((t) => $('tab-' + t).getAttribute('aria-selected') === 'true'), j = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
  selectTab(TABS[j]); $('tab-' + TABS[j]).focus(); });

function renderAll() { renderOverview(); fillGroupSelects(); renderMaterials(); renderPrice(); renderChanges(); renderCoding(); renderChecks(); setCodingPill(); renderControl(); }

// ------------------------------------------------------------------ charts
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const series = () => ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(cssVar);
function baseOpts(extra) {
  Chart.defaults.font.family = '"Segoe UI",Tahoma,system-ui,Arial,sans-serif'; Chart.defaults.color = cssVar('--chart-text');
  return Object.assign({ responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: {} } } }, extra);
}
function chart(id, cfg) { if (state.charts[id]) state.charts[id].destroy(); state.charts[id] = new Chart($(id), cfg); }
// group colours: fixed by total cost across the whole load, never by what a filter leaves
function groupColours(A) { const col = series(), m = new Map(); A.byGroup.slice(0, 7).forEach((g, i) => m.set(g.key, col[i])); return { m, other: col[7] }; }
function renderCharts() {
  const A = state.A, gc = groupColours(A), months = A.months;
  const top = A.byGroup.slice(0, 7), rest = A.byGroup.slice(7);
  const ds = top.map((g) => ({ label: g.key, data: months.map((m) => g.byMonth[m] || 0), backgroundColor: gc.m.get(g.key), borderColor: cssVar('--panel'), borderWidth: 1, borderRadius: 2 }));
  if (rest.length) ds.push({ label: `Other ${rest.length} groups`, data: months.map((m) => rest.reduce((s, g) => s + (g.byMonth[m] || 0), 0)), backgroundColor: gc.other, borderColor: cssVar('--panel'), borderWidth: 1 });
  chart('ch-month', { type: 'bar', data: { labels: months.map(E.mlabel), datasets: ds },
    options: baseOpts({ scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: { color: cssVar('--chart-grid') }, border: { display: false }, ticks: { callback: (v) => mEGP(v) } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${n0(c.raw)}`, footer: (it) => 'Month total: ' + n0(it.reduce((s, x) => s + x.raw, 0)) } } } }) });
  $('lg-month').innerHTML = ds.map((d) => `<span><i style="background:${d.backgroundColor}"></i>${esc(d.label)}</span>`).join('');
  // packages: coded cost only – unallocated is shown as its own neutral bar, never spread over packages
  const pk = A.byPackage.filter((p) => Math.abs(p.total) > 0.5);
  const lab = (k) => { const p = A.packages.find((x) => x.code === k); return p ? `${k} ${p.label}` : k; };
  chart('ch-pkg', { type: 'bar', data: { labels: pk.map((p) => lab(p.key)), datasets: [{ data: pk.map((p) => p.total), backgroundColor: pk.map((p) => p.key === 'UNALLOCATED' ? cssVar('--s8') : cssVar('--s1')), borderRadius: 3, barThickness: 14 }] },
    options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => n0(c.raw) + ' EGP' } } },
      scales: { x: { grid: { color: cssVar('--chart-grid') }, ticks: { callback: (v) => mEGP(v) } }, y: { grid: { display: false } } } }) });
  const coded = A.k.cost - ((A.byPackage.find((p) => p.key === 'UNALLOCATED') || {}).total || 0);
  const cs = A.k.cost ? coded / A.k.cost : 0;
  $('pk-note').textContent = `${cs > 0.999 && cs < 1 - 1e-12 ? '99.9%' : pc(cs)} of cost coded`;
  if (state.sel.mat) renderMatDetail(state.sel.mat);
  if (state.sel.price) renderPriceDetail(state.sel.price);
}

// ------------------------------------------------------------------ overview
function renderOverview() {
  const A = state.A, k = A.k, tie = A.checks.find((c) => c.id === 'total');
  $('ov-eyebrow').textContent = `${A.PLANT}${A.PROJECT ? ' · ' + A.PROJECT : ''} · report ${E.mlabel(A.reportMonth)} · cut-off ${E.tsText(A.cutoff)} · load ${A.loadNo}`;
  $('ov-title').textContent = `Material cost to the cut-off: ${n0(k.cost)} EGP`;
  const kpi = (l, v, s, lead) => `<div class="kpi${lead ? ' lead' : ''}"><div class="l">${esc(l)}</div><div class="v">${v}</div><div class="s">${s || ''}</div></div>`;
  $('kpis').innerHTML = [
    kpi('Material cost', mEGP(k.cost), `${k.costLines.toLocaleString('en-US')} WA lines · ${tie && tie.level === 'good' ? 'ties to SAP total ✓' : 'see Checks'}`, true),
    kpi(`Cost in ${E.mlabel(k.curMonth)}`, mEGP(k.thisMonth), k.lateLines ? `incl. ${n0(k.late)} late postings` : 'the report month'),
    kpi('Pending · next report', mEGP(k.pending), `${k.pendingLines.toLocaleString('en-US')} lines after the cut-off`),
    kpi('Project consumption', mEGP(k.project), pc(k.cost ? k.project / k.cost : 0) + ' of cost'),
    kpi('To subcontractors', mEGP(k.subcon), 'Z21 · recoverable'),
    kpi('Received from vendors', mEGP(k.receivedVendor), 'MB51 value, 101/102/122'),
    kpi('Owner supplied', mEGP(k.ownerSupplied), 'Z52 · MB51 value'),
    kpi('Open on PO', mEGP(k.openPO), `of ${mEGP(k.orderedVal)} ordered`),
    kpi('Materials with cost', k.materials.toLocaleString('en-US'), `${k.groups} groups · ${k.vendors} vendors`),
  ].join('');
  // where the cost went
  const byC = {}; for (const l of A.cost) byC[l.costClass] = (byC[l.costClass] || 0) + l.amt;
  $('tb-class').innerHTML = '<thead><tr><th>Movement behind the cost</th><th class="r">EGP</th><th class="r">Share</th></tr></thead><tbody>' +
    Object.entries(byC).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<tr>${td(esc(c))}${tdn(v)}<td class="r num">${pc(k.cost ? v / k.cost : 0)}</td></tr>`).join('') +
    `<tr class="tot">${td('Total')}${tdn(k.cost)}<td class="r num">100.0%</td></tr>` +
    (k.toOrders ? `<tr>${td('<span class="muted">Issued to orders – not project cost</span>')}<td class="r num muted">${n0(k.toOrders)}</td><td></td></tr>` : '') + '</tbody>';
  // groups
  const gc = groupColours(A), cm = A.curMonth;
  $('tb-group').innerHTML = '<thead><tr><th>Material group</th><th>Example</th><th class="r">Materials</th><th class="r">Cost</th><th class="r">Share</th><th class="r">' + esc(E.mlabel(cm)) + '</th><th>Suggested package</th></tr></thead><tbody>' +
    A.byGroup.map((g) => { const ex = [...g.materials].map((m) => A.mats.get(m)).sort((a, b) => b.cost - a.cost)[0]; const s = E.suggestFor(g.key === '(no group)' ? '' : g.key, A.packages).package;
      return `<tr data-group="${esc(g.key)}">${td(`<span class="legend" style="margin:0"><span><i style="background:${gc.m.get(g.key) || gc.other}"></i>${esc(g.key)}</span></span>`)}${td(`<span class="ar">${esc(ex ? ex.desc : '')}</span>`)}<td class="r num">${g.materials.size}</td>${tdn(g.total)}<td class="r num">${pc(k.cost ? g.total / k.cost : 0)}</td>${tdn(g.byMonth[cm] || 0)}${td(s ? esc(s[0]) : '')}</tr>`; }).join('') +
    `<tr class="tot">${td('Total')}${td('')}<td class="r num">${k.materials}</td>${tdn(k.cost)}<td class="r num">100.0%</td>${tdn(k.thisMonth)}${td('')}</tr></tbody>`;
  $('tb-group').querySelectorAll('tr[data-group]').forEach((tr) => tr.addEventListener('click', () => { $('mat-group').value = tr.dataset.group; $('mat-q').value = ''; renderMaterials(); selectTab('materials'); }));
  // top materials
  const top = A.list.filter((r) => Math.abs(r.cost) > 1e-9).slice(0, 15);
  $('tb-top').innerHTML = '<thead><tr><th>Material</th><th>Description</th><th>Group</th><th>Unit</th><th class="r">Qty consumed</th><th class="r">Avg issue price</th><th class="r">Weighted PO price</th><th class="r">Cost</th><th class="r">Share</th></tr></thead><tbody>' +
    top.map((r) => `<tr data-mat="${esc(r.material)}">${td(esc(r.material), 'num')}${td(`<span class="ar">${esc(r.desc)}</span>`)}${td(esc(r.group))}${td(esc(r.unit))}${tdn(r.consQty, nq)}${tdn(r.issuePrice, n2)}${tdn(r.price ? r.price.wavg : null, n2)}${tdn(r.cost)}<td class="r num">${pc(k.cost ? r.cost / k.cost : 0)}</td></tr>`).join('') + '</tbody>';
  $('tb-top').querySelectorAll('tr[data-mat]').forEach((tr) => tr.addEventListener('click', () => openMaterial(tr.dataset.mat)));
  renderCharts();
}
function openMaterial(m) { state.sel.mat = m; selectTab('materials'); renderMatDetail(m); renderMaterials(); $('mat-detail').scrollIntoView({ block: 'start' }); }

// ------------------------------------------------------------------ materials
function fillGroupSelects() {
  const gs = [...new Set(state.A.list.map((r) => r.group || '(no group)'))].sort();
  for (const id of ['mat-group', 'pr-group', 'cd-group']) { const cur = $(id).value; $(id).innerHTML = '<option value="">All groups</option>' + gs.map((g) => `<option>${esc(g)}</option>`).join(''); if (gs.includes(cur)) $(id).value = cur; }
}
const CHAIN = ['RCV_V', 'RCV_S', 'OWNER', 'RET_P', 'ISS_P', 'ISS_S', 'SCRAP', 'ISS_O', 'ISS_K', 'TRF_O', 'SUBC', 'ADJ', 'OTHER'];
const matchQ = (r, q) => !q || r.material.includes(q) || r.desc.toLowerCase().includes(q) || (r.group || '').toLowerCase().includes(q);
function renderMaterials() {
  const A = state.A, q = $('mat-q').value.trim().toLowerCase(), g = $('mat-group').value, onlyCost = $('mat-cost').checked, neg = $('mat-neg').checked;
  const chain = CHAIN.filter((c) => A.list.some((r) => Math.abs(r.qty[c] || 0) > 1e-9));
  const rows = A.list.filter((r) => matchQ(r, q) && (!g || (r.group || '(no group)') === g) && (!onlyCost || Math.abs(r.cost) > 1e-9) && (!neg || r.balance < -1e-6));
  const shown = rows.slice(0, 400);
  $('mat-note').textContent = `${rows.length.toLocaleString('en-US')} materials · cost ${n0(rows.reduce((s, r) => s + r.cost, 0))} EGP` + (rows.length > shown.length ? ` · first ${shown.length} shown, filter to narrow` : '');
  $('tb-mat').innerHTML = '<thead><tr><th>Material</th><th>Description</th><th>Group</th><th>Package</th><th>Unit</th><th class="r">Ordered</th>' +
    chain.map((c) => `<th class="r" title="${esc(E.CLASS[c].label)}">${esc(E.CLASS[c].short)}</th>`).join('') +
    '<th class="r">Stock balance</th><th class="r">Open on PO</th><th class="r">Direct / asset</th><th class="r">Cost</th><th class="r">Avg issue price</th></tr></thead><tbody>' +
    shown.map((r) => `<tr data-mat="${esc(r.material)}"${state.sel.mat === r.material ? ' class="sel"' : ''}>${td(esc(r.material), 'num')}${td(`<span class="ar">${esc(r.desc)}</span>`)}${td(esc(r.group))}${td(r.package ? `<span class="chip appr">${esc(r.package)}</span>` : '<span class="wpu">UNALLOCATED</span>')}${td(esc(r.unit))}${tdn(r.ordered, nq)}` +
      chain.map((c) => tdn(r.qty[c] || 0, nq)).join('') + `${tdn(r.balance, nq)}${tdn(r.openQty, nq)}${tdn(r.qty.DIRECT || 0, nq)}${tdn(r.cost)}${tdn(r.issuePrice, n2)}</tr>`).join('') + '</tbody>';
  $('tb-mat').querySelectorAll('tr[data-mat]').forEach((tr) => tr.addEventListener('click', () => { state.sel.mat = tr.dataset.mat; renderMatDetail(tr.dataset.mat); $('tb-mat').querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel')); tr.classList.add('sel'); $('mat-detail').scrollIntoView({ block: 'start', behavior: 'smooth' }); }));
}
for (const id of ['mat-q', 'mat-group', 'mat-cost', 'mat-neg']) $(id).addEventListener('input', renderMaterials);
function renderMatDetail(m) {
  const A = state.A, r = A.mats.get(m), host = $('mat-detail'); if (!r) { host.hidden = true; return; }
  host.hidden = false;
  const lines = A.cost.filter((l) => l.material === m), movs = A.mb.rows.filter((x) => x.material === m);
  const byW = {}; for (const l of lines) byW[l.wbs] = (byW[l.wbs] || 0) + l.amt;
  const chainRows = E.CLASSES.filter((c) => Math.abs(r.qty[c.code] || 0) > 1e-9 || Math.abs(r.val[c.code] || 0) > 1e-9);
  host.innerHTML = `<div class="hd"><div><div class="eyebrow">${esc(r.material)} · ${esc(r.group || 'no group')} · ${esc(r.unit)}</div><h2 class="ar" style="text-align:left">${esc(r.desc)}</h2></div><button id="md-close" aria-label="Close">✕</button></div>
    <div class="bd"><div class="kpis" style="background:none;padding:0">
      <div class="kpi"><div class="l">Cost</div><div class="v">${n0(r.cost)}</div><div class="s">${lines.length} CJI3 lines</div></div>
      <div class="kpi"><div class="l">Consumed</div><div class="v">${nq(r.consQty) || '0'}</div><div class="s">${esc(r.unit)} to project + subcontractors</div></div>
      <div class="kpi"><div class="l">Stock balance</div><div class="v">${nq(r.balance) || '0'}</div><div class="s">${esc(r.unit)}</div></div>
      <div class="kpi"><div class="l">Open on PO</div><div class="v">${nq(r.openQty) || '0'}</div><div class="s">${n0(r.openVal)} EGP</div></div>
      <div class="kpi"><div class="l">Avg issue price</div><div class="v">${n2(r.issuePrice) || '–'}</div><div class="s">PO ${r.price ? n2(r.price.wavg) : '–'}</div></div></div>
      <div class="chartbox" style="height:200px;margin-bottom:12px"><canvas id="ch-md" aria-label="Monthly cost of this material"></canvas></div>
      <div class="mini">
        <div><h3>Quantity chain</h3><div class="tblwrap"><table><thead><tr><th>Class</th><th class="r">Qty</th><th class="r">MB51 value</th></tr></thead><tbody>${chainRows.map((c) => `<tr>${td(esc(c.label))}${tdn(r.qty[c.code] || 0, nq)}${tdn(r.val[c.code] || 0)}</tr>`).join('')}<tr class="tot">${td('Stock balance')}${tdn(r.balance, nq)}${td('')}</tr></tbody></table></div></div>
        <div><h3>Cost by WBS</h3><div class="tblwrap"><table><thead><tr><th>WBS</th><th class="r">Cost</th></tr></thead><tbody>${Object.entries(byW).sort((a, b) => b[1] - a[1]).map(([w, v]) => `<tr>${td(esc(w), 'num')}${tdn(v)}</tr>`).join('') || '<tr><td colspan="2" class="muted">No cost</td></tr>'}</tbody></table></div></div>
      </div>
      <h3 style="margin-top:14px">PO lines (${r.po.length})</h3><div class="tblwrap" style="max-height:260px">${poTable(r.po)}</div>
      <h3 style="margin-top:14px">Movements (${movs.length})</h3><div class="tblwrap" style="max-height:300px"><table><thead><tr><th>Date</th><th>Mvt</th><th>Class</th><th class="r">Qty</th><th class="r">MB51 value</th><th class="r">CJI3 cost</th><th>WBS / order</th><th>PO</th><th>Material doc</th></tr></thead><tbody>${
        movs.slice().sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 300).map((x) => `<tr>${td(E.dtext(x.date), 'num')}${td(esc(x.mvt))}${td(esc(E.CLASS[x.cls].short))}${tdn(x.qty, nq)}${tdn(x.amt)}${tdn(x.costLine ? x.costLine.amt : null)}${td(esc(x.wbs || x.order), 'num')}${td(esc(x.po), 'num')}${td(esc(x.doc + '/' + x.item), 'num')}</tr>`).join('')}</tbody></table></div></div>`;
  $('md-close').addEventListener('click', () => { host.hidden = true; state.sel.mat = null; renderMaterials(); });
  chart('ch-md', { type: 'bar', data: { labels: A.months.map(E.mlabel), datasets: [{ label: 'Cost', data: A.months.map((mm) => r.byMonth[mm] || 0), backgroundColor: cssVar('--s1'), borderRadius: 3 }] },
    options: baseOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Cost ${n0(c.raw)} · qty ${nq(r.qtyByMonth[A.months[c.dataIndex]] || 0) || '0'} ${r.unit}` } } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: cssVar('--chart-grid') }, ticks: { callback: (v) => mEGP(v) } } } }) });
}
function poTable(pos) {
  return `<table><thead><tr><th>PO / item</th><th>Date</th><th>Kind</th><th>Supplier</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Value</th><th class="r">Open qty</th><th>Del.</th></tr></thead><tbody>${
    pos.slice().sort((a, b) => (b.date || 0) - (a.date || 0)).map((l) => `<tr>${td(esc(l.key), 'num')}${td(E.dtext(l.date), 'num')}${td(l.kind === 'STO' ? '<span class="chip">STO</span>' : 'PUR')}${td(`<span class="ar">${esc(l.vendor)}</span>`)}${tdn(l.qty, nq)}${tdn(l.unitPrice || null, n2)}${tdn(l.value)}${tdn(l.openQty, nq)}${td(l.del ? `<span class="chip rem">${esc(l.del)}</span>` : '')}</tr>`).join('') || '<tr><td colspan="9" class="muted">No PO lines in ME2N</td></tr>'}</tbody></table>`;
}

// ------------------------------------------------------------------ price
function renderPrice() {
  const A = state.A, q = $('pr-q').value.trim().toLowerCase(), g = $('pr-group').value, v = $('pr-var').checked;
  const rows = A.list.filter((r) => (r.price || r.issuePrice !== null) && matchQ(r, q) && (!g || (r.group || '(no group)') === g) && (!v || (r.priceVar !== null && Math.abs(r.priceVar) > 0.1)));
  const shown = rows.slice(0, 400);
  const varChip = (x) => x === null ? '' : `<span class="chip ${Math.abs(x) <= 0.1 ? '' : (x > 0 ? 'rem' : 'new')}">${x > 0 ? '+' : ''}${pc(x)}</span>`;
  $('tb-price').innerHTML = '<thead><tr><th>Material</th><th>Description</th><th>Unit</th><th class="r">PO lines</th><th class="r">Vendors</th><th class="r">Min PO</th><th class="r">Max PO</th><th class="r">Spread</th><th class="r">Weighted PO</th><th class="r">Last PO</th><th>Last PO date</th><th class="r">Avg issue</th><th class="r">Issue vs PO</th><th class="r">Cost</th></tr></thead><tbody>' +
    shown.map((r) => { const p = r.price; return `<tr data-mat="${esc(r.material)}"${state.sel.price === r.material ? ' class="sel"' : ''}>${td(esc(r.material), 'num')}${td(`<span class="ar">${esc(r.desc)}</span>`)}${td(esc(r.unit))}<td class="r num">${p ? p.n : ''}</td><td class="r num">${p ? p.vendors : ''}</td>${tdn(p ? p.min : null, n2)}${tdn(p ? p.max : null, n2)}<td class="r num">${p && p.spread ? pc(p.spread) : ''}</td>${tdn(p ? p.wavg : null, n2)}${tdn(p ? p.last.unitPrice : null, n2)}${td(p ? E.dtext(p.last.date) : '', 'num')}${tdn(r.issuePrice, n2)}<td class="r">${varChip(r.priceVar)}</td>${tdn(r.cost)}</tr>`; }).join('') + '</tbody>';
  $('tb-price').querySelectorAll('tr[data-mat]').forEach((tr) => tr.addEventListener('click', () => { state.sel.price = tr.dataset.mat; renderPriceDetail(tr.dataset.mat); $('tb-price').querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel')); tr.classList.add('sel'); $('price-detail').scrollIntoView({ block: 'start', behavior: 'smooth' }); }));
}
for (const id of ['pr-q', 'pr-group', 'pr-var']) $(id).addEventListener('input', renderPrice);
function renderPriceDetail(m) {
  const A = state.A, r = A.mats.get(m), host = $('price-detail'); if (!r) { host.hidden = true; return; }
  host.hidden = false;
  const pl = r.po.filter((l) => l.kind === 'PUR' && l.unitPrice > 0 && l.del !== 'L');
  const mk = new Set(A.months); for (const l of pl) if (l.date) mk.add(E.monthKey(l.date));
  const months = [...mk].sort((a, b) => a - b);
  // PO price per month = quantity-weighted over the POs dated in that month; issue price = cost ÷ qty issued that month
  const poM = months.map((mm) => { const ls = pl.filter((l) => l.date && E.monthKey(l.date) === mm); const q = ls.reduce((s, l) => s + l.qty, 0);
    return ls.length ? (q ? ls.reduce((s, l) => s + l.unitPrice * l.qty, 0) / q : ls.reduce((s, l) => s + l.unitPrice, 0) / ls.length) : null; });
  const isM = months.map((mm) => (r.qtyByMonth[mm] || 0) > 1e-9 ? (r.issCostByMonth[mm] || 0) / r.qtyByMonth[mm] : null);
  host.innerHTML = `<div class="hd"><div><div class="eyebrow">${esc(r.material)} · ${esc(r.group)} · EGP per ${esc(r.unit)}</div><h2 class="ar" style="text-align:left">${esc(r.desc)}</h2></div><button id="pd-close" aria-label="Close">✕</button></div>
    <div class="bd"><div class="chartbox" style="height:240px"><canvas id="ch-pd" aria-label="PO price and issue price per month"></canvas></div>
    <div class="legend"><span><i style="background:${cssVar('--s1')}"></i>PO price (weighted, by PO date)</span><span><i style="background:${cssVar('--s2')}"></i>Issue price (cost ÷ qty issued)</span></div>
    <h3 style="margin-top:14px">Purchase lines</h3><div class="tblwrap" style="max-height:280px">${poTable(pl)}</div></div>`;
  $('pd-close').addEventListener('click', () => { host.hidden = true; state.sel.price = null; renderPrice(); });
  chart('ch-pd', { type: 'line', data: { labels: months.map(E.mlabel), datasets: [
    { label: 'PO price', data: poM, borderColor: cssVar('--s1'), backgroundColor: cssVar('--s1'), showLine: false, pointRadius: 5, pointHoverRadius: 6 },
    { label: 'Issue price', data: isM, borderColor: cssVar('--s2'), backgroundColor: cssVar('--s2'), pointRadius: 3, borderWidth: 2, spanGaps: false }] },
    options: baseOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.raw === null ? null : `${c.dataset.label}: ${n2(c.raw)}` } } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: cssVar('--chart-grid') }, ticks: { callback: (v) => n0(v) } } } }) });
}

// ------------------------------------------------------------------ changes
function renderChanges() {
  const A = state.A, C = A.changes, loads = E.summarize(A).loads;
  $('tb-loads').innerHTML = '<thead><tr><th>Load</th><th>Run on</th><th>Report</th><th>Cut-off</th><th class="r">Material cost</th><th class="r">Project consumption</th><th class="r">To subcontractors</th><th class="r">Open PO value</th><th class="r">Materials</th><th>Files</th></tr></thead><tbody>' +
    loads.map((l, i) => `<tr${i === loads.length - 1 ? ' class="tot"' : ''}><td class="num">${l.no}</td>${td(E.dtext(l.run), 'num')}${td(l.reportMonth ? E.mlabel(l.reportMonth) : '')}${td(l.cutoff && isFinite(l.cutoff) ? E.tsText(l.cutoff) : '', 'num')}${tdn(l.cost)}${tdn(l.project)}${tdn(l.subcon)}${tdn(l.openPO)}<td class="r num">${l.materials || ''}</td>${td(`<span class="muted">${esc(l.files || '')}</span>`)}</tr>`).join('') + '</tbody>';
  if (!C.has) {
    $('chg-kpis').innerHTML = ''; $('chg-note').textContent = '';
    $('tb-chg').innerHTML = '<tbody><tr><td class="muted">No previous report loaded. Download this report, and load it next month alongside the new exports – this tab will then list every material whose cost, consumption, stock or open PO moved.</td></tr></tbody>';
    $('tb-npo').innerHTML = ''; $('npo-note').textContent = ''; return;
  }
  const kpi = (l, v, s) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const cnt = C.count || {};
  $('chg-kpis').innerHTML = ['New', 'Cost moved', 'Qty moved', 'Gone'].map((t) => kpi(t, (cnt[t] || [0])[0], 'Δ cost ' + n0((cnt[t] || [0, 0])[1]))).join('') + kpi('New PO lines', C.newPO.length, n0(C.newPO.reduce((s, l) => s + l.value, 0)) + ' EGP');
  $('chg-note').textContent = `against load ${C.prevLoad || '?'}, data to ${E.dtext(C.prevDate)}`;
  const chip = { New: 'new', 'Cost moved': 'chg', 'Qty moved': 'appr', Gone: 'rem' };
  $('tb-chg').innerHTML = '<thead><tr><th>Change</th><th>Material</th><th>Description</th><th>Unit</th><th class="r">Cost before</th><th class="r">Cost now</th><th class="r">Δ cost</th><th class="r">Consumed Δ</th><th class="r">Balance before</th><th class="r">Balance now</th><th class="r">Open PO before</th><th class="r">Open PO now</th></tr></thead><tbody>' +
    C.rows.slice(0, 1000).map((x) => `<tr>${td(`<span class="chip ${chip[x.type]}">${x.type}</span>`)}${td(esc(x.r.material), 'num')}${td(`<span class="ar">${esc(x.r.desc)}</span>`)}${td(esc(x.r.unit || ''))}${tdn(x.prev ? x.prev.cost : null)}${tdn(x.now.cost)}${tdn(x.now.cost - (x.prev ? x.prev.cost : 0))}${tdn(x.now.cons - (x.prev ? x.prev.cons : 0), nq)}${tdn(x.prev ? x.prev.bal : null, nq)}${tdn(x.now.bal, nq)}${tdn(x.prev ? x.prev.open : null, nq)}${tdn(x.now.open, nq)}</tr>`).join('') + '</tbody>';
  $('npo-note').textContent = `${C.newPO.length} lines in ME2N that the last report did not have`;
  $('tb-npo').innerHTML = C.newPO.length ? poTable(C.newPO).replace(/^<table>|<\/table>$/g, '') : '<tbody><tr><td class="muted">None.</td></tr></tbody>';
}

// ------------------------------------------------------------------ coding
function setCodingPill() {
  const A = state.A; if (!A) return;
  const withCost = A.list.filter((r) => Math.abs(r.cost) > 1e-9), coded = withCost.filter((r) => r.package);
  const share = A.k.cost ? coded.reduce((s, r) => s + r.cost, 0) / A.k.cost : 0;
  $('dot-coding').className = 'dot ' + (share > 0.999 ? 'on' : 'off');
  $('txt-coding').textContent = `Coding: ${coded.length}/${withCost.length} materials · ${share > 0.999 && coded.length < withCost.length ? '99.9%' : pc(share)} of cost`;
}
function codeFiltered() {
  const A = state.A, q = $('cd-q').value.trim().toLowerCase(), g = $('cd-group').value, open = $('cd-open').checked, cost = $('cd-cost').checked;
  return A.list.filter((r) => matchQ(r, q) && (!g || (r.group || '(no group)') === g) && (!open || !r.package) && (!cost || Math.abs(r.cost) > 1e-9));
}
function renderCodingSummary() {
  const rows = codeFiltered(); state.codeRows = rows;
  $('cd-count').textContent = `${rows.length.toLocaleString('en-US')} rows · ${n0(rows.reduce((s, r) => s + r.cost, 0))} EGP`;
  const A = state.A, withCost = A.list.filter((r) => Math.abs(r.cost) > 1e-9), coded = withCost.filter((r) => r.package);
  $('cd-summary').textContent = `${coded.length} of ${withCost.length} materials with cost have a package`;
}
function pkgOptions(sel, blank) { return (blank ? `<option value="">${blank}</option>` : '') + state.A.packages.map((p) => `<option value="${esc(p.code)}"${p.code === sel ? ' selected' : ''}>${esc(p.code)} · ${esc(p.label)}</option>`).join(''); }
function mnlOptions(sel, blank) { return (blank ? `<option value="">${blank}</option>` : '') + state.A.mnls.map((m) => `<option value="${esc(m.code)}"${m.code === sel ? ' selected' : ''}>${esc(m.code)}</option>`).join(''); }
function renderCoding() {
  const A = state.A; renderCodingSummary();
  $('cd-setpkg').innerHTML = pkgOptions('', '—'); $('cd-setmnl').innerHTML = mnlOptions('', '—');
  const rows = state.codeRows.slice(0, state.codeLimit);
  $('cd-more').hidden = state.codeRows.length <= state.codeLimit; $('cd-more').textContent = `Show ${Math.min(300, state.codeRows.length - state.codeLimit)} more`;
  $('tb-code').innerHTML = '<thead><tr><th>Material</th><th>Description</th><th>Group</th><th class="r">Cost</th><th>Package</th><th>MNL</th><th>Cost element</th></tr></thead><tbody>' +
    rows.map((r) => codeRow(r)).join('') + '</tbody>';
}
function codeRow(r) {
  const s = r.sugg || {}, sp = s.package && !r.package ? `<span class="sugg" title="${esc(s.package[1])}">${esc(s.package[0])}<button data-acc="package" data-v="${esc(s.package[0])}" title="Accept">✓</button></span>` : '';
  const sm = s.mnl && !r.mnl ? `<span class="sugg" title="${esc(s.mnl[1])}">${esc(s.mnl[0])}<button data-acc="mnl" data-v="${esc(s.mnl[0])}" title="Accept">✓</button></span>` : '';
  return `<tr data-mat="${esc(r.material)}">${td(esc(r.material), 'num')}${td(`<span class="ar">${esc(r.desc)}</span>`)}${td(esc(r.group))}${tdn(r.cost)}` +
    `<td class="bd"><select data-dim="package" aria-label="Package">${pkgOptions(r.package, '— unallocated —')}</select> ${sp}</td>` +
    `<td class="bd"><select data-dim="mnl" aria-label="MNL">${mnlOptions(r.mnl, '—')}</select> ${sm}</td>` +
    `<td><input class="cec" data-dim="cec" value="${esc(r.cec)}" aria-label="Cost element"></td></tr>`;
}
function setCode(material, dim, value) {
  saveCode(state.plant, material, { [dim]: value });
  const r = state.A.mats.get(material); if (r) r[dim] = value;
}
$('tb-code').addEventListener('change', (e) => {
  const el = e.target, tr = el.closest('tr[data-mat]'); if (!tr || !el.dataset.dim) return;
  setCode(tr.dataset.mat, el.dataset.dim, el.value.trim()); refreshCodeRow(tr.dataset.mat); recode();
});
$('tb-code').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-acc]'); if (!b) return; const tr = b.closest('tr[data-mat]');
  setCode(tr.dataset.mat, b.dataset.acc, b.dataset.v); refreshCodeRow(tr.dataset.mat); recode();
});
function refreshCodeRow(m) { const tr = $('tb-code').querySelector(`tr[data-mat="${CSS.escape(m)}"]`); const r = state.A.mats.get(m); if (tr && r) tr.outerHTML = codeRow(r); }
$('cd-accept').addEventListener('click', () => {
  let n = 0; for (const r of state.codeRows) for (const d of ['package', 'mnl']) if (!r[d] && r.sugg && r.sugg[d]) { setCode(r.material, d, r.sugg[d][0]); n++; }
  recode(); renderCoding(); $('cd-count').textContent += ` · ${n} suggestions accepted`;
});
$('cd-apply').addEventListener('click', () => {
  const pk = $('cd-setpkg').value, mn = $('cd-setmnl').value; if (!pk && !mn) return;
  if (state.codeRows.length > 50 && !confirm(`Set ${[pk && 'package ' + pk, mn && 'MNL ' + mn].filter(Boolean).join(' and ')} on ${state.codeRows.length} materials?`)) return;
  for (const r of state.codeRows) { if (pk) setCode(r.material, 'package', pk); if (mn) setCode(r.material, 'mnl', mn); }
  recode(); renderCoding();
});
for (const id of ['cd-q', 'cd-group', 'cd-open', 'cd-cost']) $(id).addEventListener('input', () => { state.codeLimit = 300; renderCoding(); });
$('cd-more').addEventListener('click', () => { state.codeLimit += 300; renderCoding(); });

// ------------------------------------------------------------------ checks
function renderChecks() {
  const A = state.A, ic = { good: '✓', warn: '!', bad: '✗', info: 'i' };
  const cell = (v, h) => typeof v === 'number' ? `<td class="r num${v < -1e-9 ? ' neg' : ''}">${/Variance|vs PO/.test(h) ? pc(v) : (Number.isInteger(v) || Math.abs(v) >= 1000 ? n0(v) : n2(v))}</td>` : (v instanceof Date ? td(E.dtext(v), 'num') : td(`<span class="ar">${esc(v)}</span>`));
  $('checks').innerHTML = A.warnings.map((w) => `<div class="msg warn">${esc(w)}</div>`).join('') + A.checks.map((c) => `<details class="chk ${c.level}"><summary><span class="ic">${ic[c.level]}</span><span class="t">${esc(c.title)}</span><span class="n">${c.count ? c.count.toLocaleString('en-US') + ' rows' : ''}${c.amount && Math.abs(c.amount) > 0.5 ? ' · ' + n0(c.amount) : ''}</span><span class="d">${esc(c.detail)}</span></summary>${
    c.rows.length ? `<div class="body tblwrap" style="max-height:360px"><table><thead><tr>${c.cols.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${c.rows.map((r) => '<tr>' + r.map((v, j) => cell(v, c.cols[j])).join('') + '</tr>').join('')}</tbody></table></div>` : ''}</details>`).join('');
  $('tb-rules').innerHTML = '<thead><tr><th>Mvt</th><th>Movement text</th><th>Class</th><th>Stock</th><th class="r">Lines</th><th class="r">Qty</th><th class="r">MB51 value</th><th class="r">Cost in CJI3</th></tr></thead><tbody>' +
    A.mvtTypes.map((t) => `<tr>${td(esc(t.mvt), 'num')}${td(esc(t.text))}${td(esc(E.CLASS[t.cls].label))}${td(E.CLASS[t.cls].stock ? 'yes' : '<span class="chip">no</span>')}<td class="r num">${t.n}</td>${tdn(t.qty, nq)}${tdn(t.amt)}${tdn(t.costN ? t.cost : null)}</tr>`).join('') + '</tbody>';
}
function renderControl() {
  const A = state.A, t = A.checks.find((c) => c.id === 'total'), u = A.checks.find((c) => c.id === 'unmatched');
  $('control').innerHTML = `<b>CONTROL</b><span>cut-off ${E.tsText(A.cutoff)}</span><span>reported ${n0(A.k.cost)} + pending ${n0(A.k.pending)} = CJI3 WA ${n0(A.k.costAll)}</span><span>printed total ${A.k.printedTotal === null ? '–' : n0(A.k.printedTotal)}</span>` +
    `<span class="${t.level === 'good' ? 'ok' : 'bad'}">${t.level === 'good' ? '✓ ties' : '✗ does not tie'}</span>` +
    `<span class="${u.level === 'good' ? 'ok' : 'bad'}">${u.level === 'good' ? '✓ every line has its movement' : `✗ ${u.count} lines without movement`}</span>` +
    `<span>${A.k.movements.toLocaleString('en-US')} movements · ${A.k.poLines.toLocaleString('en-US')} PO lines · ${A.k.wbs} WBS</span>`;
}

// ------------------------------------------------------------------ download
$('btn-download').addEventListener('click', async () => {
  const A = state.A; $('btn-download').disabled = true; $('dl-status').textContent = 'Writing the workbook…'; await tick();
  try {
    const buf = await E.buildWorkbook(A, { ExcelJS, JSZip });
    const name = `Material Cost Report - ${A.PLANT || 'project'} - ${E.mtext(A.curMonth)}.xlsx`;
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('dl-status').textContent = `Saved ${name}. Keep it – next month it is the "last report" that carries coding and history forward.`;
  } catch (e) { $('dl-status').textContent = 'Could not write the workbook: ' + e.message; }
  $('btn-download').disabled = false;
});

// ------------------------------------------------------------------ report period (step 2)
// The cut-off is a moment in time: whatever SAP stamped as entered after it is Pending and belongs to the next report.
// Every report stores its report month and cut-off, so months already reported never change.
const two = (n) => String(n).padStart(2, '0');
function cutoffValue() {
  const d = $('p-date').value; if (!d) return null;
  const t = ($('p-time').value || '23:59:59').split(':').map(Number);
  return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), t[0] || 0, t[1] || 0, t[2] || 0);
}
function setCutoff(ms) { const x = new Date(ms); $('p-date').value = `${x.getUTCFullYear()}-${two(x.getUTCMonth() + 1)}-${two(x.getUTCDate())}`;
  $('p-time').value = `${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())}`; periodChanged(); }
function setupPeriod() {
  const info = E.periodInfo(state.files); if (!info) return;
  state.period = info; $('period').hidden = false;
  const prev = state.prev, pm = prev && prev.meta.reportMonth, pc0 = prev && prev.meta.cutoff;
  const months = new Set(info.months); if (pm) months.add(E.nextMonth(pm));
  const list = [...months].sort((a, b) => b - a), keep = +$('p-month').value;
  $('p-month').innerHTML = list.map((m) => `<option value="${m}">${E.mlabel(m)}</option>`).join('');
  $('p-month').value = String(list.includes(keep) ? keep : (pm && list.includes(E.nextMonth(pm)) ? E.nextMonth(pm) : list[0]));
  const ob = $('p-open').value;
  $('p-open').innerHTML = '<option value="0">No roll-up</option>' + [...info.months].sort((a, b) => a - b).slice(1).map((m) => `<option value="${m}">Months before ${E.mlabel(m)}</option>`).join('');
  $('p-open').value = ob && [...$('p-open').options].some((o) => o.value === ob) ? ob : String(prev && prev.meta.openingBefore ? prev.meta.openingBefore : 0);
  $('p-latest').textContent = `Latest entry in the files (${E.tsText(info.maxEntry)})`;
  $('p-last').innerHTML = prev && pm ? `Last report: <b>${E.mlabel(pm)}</b>, cut-off <b>${esc(E.tsText(pc0))}</b>. Lines entered after it and posted in ${E.mlabel(pm)} or earlier are counted in this report as late postings.`
    : 'First report: every line entered up to the cut-off sits in its posting month.';
  if (!info.hasTs) message('msgs', 'warn', 'This CJI3 export has no "Created on" column, so the cut-off can only use posting dates. Add Created on and Time of Entry to the CJI3 layout.');
  periodChanged();
}
let pvTimer = null;
function periodChanged() { updateBuild(); clearTimeout(pvTimer); pvTimer = setTimeout(previewPeriod, 250); }
for (const id of ['p-month', 'p-date', 'p-time', 'p-open']) $(id).addEventListener('input', periodChanged);
$('p-eom').addEventListener('click', () => { const m = +$('p-month').value; setCutoff(Date.UTC(Math.floor(m / 100), m % 100, 1) - 1000); });
$('p-latest').addEventListener('click', () => { if (state.period && state.period.maxEntry) setCutoff(state.period.maxEntry); });
function periodProblem() {
  const c = cutoffValue(), m = +$('p-month').value, prev = prevFits() || (state.prev && !state.plant) ? state.prev : null;
  if (c === null) return 'Choose the cut-off date (and time) to build the report.';
  if (m && c < Date.UTC(Math.floor(m / 100), (m % 100) - 1, 1)) return `The cut-off is before ${E.mlabel(m)} starts – pick a later cut-off or an earlier report month.`;
  if (prev && prev.meta.reportMonth && m > prev.meta.reportMonth && prev.meta.cutoff && c <= prev.meta.cutoff)
    return `The cut-off must be later than the last report's (${E.tsText(prev.meta.cutoff)}).`;
  return null;
}
function updateBuild() {
  const ready = ['me', 'mb', 'cji'].every((k) => state.files[k]);
  $('btn-build').disabled = !ready || !!periodProblem();
}
function previewPeriod() {
  const host = $('p-preview'); host.innerHTML = '';
  if (!state.period) return;
  const bad = periodProblem(); if (bad) { host.innerHTML = `<div class="msg warn">${esc(bad)}</div>`; return; }
  if (!state.plant) state.plant = guessPlant();
  if (!state.coding) state.coding = codingFor(state.plant);
  const A = analyse(); if (A.errors) return;
  const m = +$('p-month').value, prev = prevFits() ? state.prev : null;
  const rerun = prev && prev.meta.reportMonth && m <= prev.meta.reportMonth;
  host.innerHTML = `<div class="msg good">Up to the cut-off: <b>${n0(A.k.cost)}</b> EGP in ${A.k.costLines.toLocaleString('en-US')} lines` +
    `<br>Pending for the next report: <b>${n0(A.k.pending)}</b> (${A.k.pendingLines.toLocaleString('en-US')} lines)` +
    (A.history.length ? `<br>Late postings counted in ${E.mlabel(m)}: <b>${n0(A.k.late)}</b> (${A.k.lateLines} lines)` : '') + '</div>' +
    (rerun ? `<div class="msg warn">${E.mlabel(m)} was already reported (load ${prev.meta.loadNo}). Building it again replaces that report; earlier months stay as they were.</div>` : '');
}
