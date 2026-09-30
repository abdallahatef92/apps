"""Build the offline, no-sign-in version of the report tool from page.html + engine.js.
Differences from the artifact: libraries embedded, system fonts, plain browser downloads,
and a coding master .xlsx instead of the shared database."""
import sys, re
S = open('page.html').read()

def R(a, b, count=1):
    global S
    n = S.count(a)
    assert n == count, (a[:80], n)
    S = S.replace(a, b)

# ---- fonts: no network
R('''<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
''', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n')
R('--sans:"IBM Plex Sans","IBM Plex Sans Arabic",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;',
  '--sans:"Segoe UI",Tahoma,system-ui,-apple-system,Roboto,Arial,sans-serif;')
R('--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;', '--mono:Consolas,"Cascadia Mono",ui-monospace,SFMono-Regular,Menlo,monospace;')
R('.ar{font-family:"IBM Plex Sans Arabic",var(--sans);', '.ar{font-family:"Segoe UI",Tahoma,Arial,sans-serif;')
R('''Chart.defaults.font.family = '"IBM Plex Sans","IBM Plex Sans Arabic",system-ui,sans-serif';''', '''Chart.defaults.font.family = '"Segoe UI",Tahoma,system-ui,Arial,sans-serif';''')

# ---- header, pills, slots, notes
R("Your files are read in this browser and are not uploaded.</p>", "Works offline: files are read in this browser and nothing is uploaded.</p>")
R('''      <span class="pill" id="pill-dl"><i class="dot" id="dot-dl"></i><span id="txt-dl">Excel download: checking…</span></span>
''', '')
R('<span id="txt-coding">Shared coding: connecting…</span>', '<span id="txt-coding">Coding master: not loaded</span>')
R('''          <div class="slot" id="slot-prev"><span class="tag">LAST REPORT</span>''',
  '''          <div class="slot" id="slot-master"><span class="tag">CODING MASTER</span><span class="name" id="name-master">Service_Coding_Master.xlsx — optional</span><span class="meta" id="meta-master">Team codes from the shared drive</span></div>
          <div class="slot" id="slot-prev"><span class="tag">LAST REPORT</span>''')
R('<div class="note">Only service codes with the Unit, CSI, MNL and Cost Element Code you type are saved, to the team\'s shared coding. Certificate data stays on this device.</div>',
  '<div class="note">Codes you type on the Service coding tab stay in this page until you download the updated coding master. Save it over the old master on the shared drive.</div>')
R("<li>CSI, MNL and Cost Element Code come from the shared coding, which you can edit here after you build a report.</li>",
  "<li>CSI, MNL and Cost Element Code come from the coding master on your shared drive. Edit them on the Service coding tab and download the updated master.</li>")
R('<h3>Service coding — shared with your team</h3>', '<h3>Service coding</h3>')
R('<button id="btn-import" hidden>Add codes from last report</button>', '<button id="btn-master">Download updated coding master</button>')
R('<div class="note">Each entry saves when you leave the box. Codes apply to every project that uses the same service code and text. To use new codes, download the Excel report again.</div>',
  '<div class="note">Codes apply to every project that uses the same service code and text. They are kept in this page until you download the updated coding master; download the Excel report again to include them.</div>')
R('<button class="primary" id="btn-download">Prepare Excel report</button>', '<button class="primary" id="btn-download">Download Excel report</button>')

# ---- JS: state, coding store, downloads
R("const state = { files: {}, prev: null, analysis: null, summary: null, coding: new Map(), codingDocs: new Map(), db: null, downloads: null, charts: {} };",
  "const state = { files: {}, prev: null, master: new Map(), masterName: null, edits: new Map(), analysis: null, summary: null, charts: {} };")
a = S.index("// ---------------------------------------------------------------- shared coding (db)")
b = S.index("// ---------------------------------------------------------------- files")
S = S[:a] + '''// ---------------------------------------------------------------- coding (master file + edits on this page)
// precedence: typed on this page > coding master > last month's report
function prevCodes() {
  const m = new Map();
  if (state.prev) for (const [k, v] of state.prev.coding) {
    const own = /Your entry/.test(v.unitSrc || '');
    if (v.csi || v.mnl || v.cec || own) m.set(k, { unit: own ? v.unit : '', csi: v.csi || '', mnl: v.mnl || '', cec: v.cec || '' });
  }
  return m;
}
function effectiveCoding() {
  const m = prevCodes();
  for (const [k, v] of state.master) { const o = m.get(k) || {}; m.set(k, { unit: v.unit || o.unit || '', csi: v.csi || o.csi || '', mnl: v.mnl || o.mnl || '', cec: v.cec || o.cec || '' }); }
  for (const [k, v] of state.edits) { const o = m.get(k) || {}; m.set(k, Object.assign({}, o, v)); }
  return m;
}
function setCodingPill() {
  const coded = [...state.master.values()].filter((e) => e.csi || e.mnl || e.cec).length;
  $('dot-coding').className = 'dot ' + (state.master.size ? 'on' : 'off');
  $('txt-coding').textContent = state.master.size ? `Coding master: ${state.master.size.toLocaleString('en-US')} services, ${coded.toLocaleString('en-US')} coded` + (state.edits.size ? ` · ${state.edits.size} unsaved edits` : '') : 'Coding master: not loaded' + (state.edits.size ? ` · ${state.edits.size} unsaved edits` : '');
}
function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

''' + S[b:]

# ---- file intake: recognise the coding master
R("""      if (wb.SheetNames.includes('_History') || wb.SheetNames.includes('_Lines')) {""",
  """      if (wb.SheetNames.includes(E.MASTER_SHEET)) {
        state.master = E.readCodingMaster(XLSX.utils.sheet_to_json(wb.Sheets[E.MASTER_SHEET], { header: 1, raw: true, defval: '' })); state.masterName = f.name;
        const coded = [...state.master.values()].filter((e) => e.csi || e.mnl || e.cec).length;
        setSlot('master', f.name, `${state.master.size.toLocaleString('en-US')} services · ${coded.toLocaleString('en-US')} with codes`); setCodingPill();
        continue;
      }
      if (wb.SheetNames.includes('_History') || wb.SheetNames.includes('_Lines')) {""")
R("else message('msgs', 'warn', `${f.name} is not a ZSCPROG01 or ZSCSRV1 export, or a report from this page.",
  "else message('msgs', 'warn', `${f.name} is not a ZSCPROG01 or ZSCSRV1 export, a coding master, or a report from this page.")
R("  $('btn-clear').disabled = !(state.files.prog || state.files.serv || state.prev);",
  "  $('btn-clear').disabled = !(state.files.prog || state.files.serv || state.prev || state.master.size);")
R("""  state.files = {}; state.prev = null; state.analysis = null;
  [['prog', 'Certificates — required', 'Subcontractor progress / certificate lines'], ['serv', 'PO service lines — required', 'Units, material groups, contract qty'], ['prev', "Last month's report — optional", 'Brings load history, changes and coding forward']]""",
  """  state.files = {}; state.prev = null; state.analysis = null; state.master = new Map(); state.masterName = null; setCodingPill();
  [['prog', 'Certificates — required', 'Subcontractor progress / certificate lines'], ['serv', 'PO service lines — required', 'Units, material groups, contract qty'], ['master', 'Service_Coding_Master.xlsx — optional', 'Team codes from the shared drive'], ['prev', "Last month's report — optional", 'Brings load history, changes and coding forward']]""")
a = S.index("function mergedCoding() {")
b = S.index("function analyseNow() {")
S = S[:a] + "function mergedCoding() { return effectiveCoding(); }\n" + S[b:]

# ---- report download: one click, plain browser download
a = S.index("// Two steps so the save runs straight from its own click")
b = S.index("// ---------------------------------------------------------------- tabs")
S = S[:a] + '''function resetPrepared() {}
$('btn-download').addEventListener('click', async () => {
  const st = $('dl-status'); const b = $('btn-download'); b.disabled = true;
  try {
    const A = analyseNow();
    const buf = await E.buildWorkbook(A, { ExcelJS, JSZip }, async (what) => { st.textContent = `Building the workbook: ${what}…`; await tick(); });
    const name = `${A.PLANT}_service_report_load${A.loadNo}_${fmtD(A.dataDate)}.xlsx`;
    saveBlob(name, new Blob([buf], { type: XLSX_TYPE }));
    st.textContent = `Downloaded ${name} (${(buf.length / 1048576).toFixed(1)} MB). Next month, drop it here with the new SAP files.`;
  } catch (e) { st.textContent = `The workbook could not be built: ${(e && e.message) || e}`; }
  b.disabled = false;
});
$('btn-master').addEventListener('click', async () => {
  const st = $('cd-status'); const b = $('btn-master'); b.disabled = true;
  try {
    // fold last month's report codes into blanks of the master, then this page's edits on top
    const fold = new Map();
    for (const [k, v] of prevCodes()) { const m = state.master.get(k) || {}; const x = {}; for (const f of ['unit', 'csi', 'mnl', 'cec']) if (v[f] && !m[f]) x[f] = v[f]; if (Object.keys(x).length) fold.set(k, x); }
    for (const [k, v] of state.edits) fold.set(k, Object.assign(fold.get(k) || {}, v));
    const r = E.mergeCodingMaster(state.master, state.analysis, fold);
    const buf = await E.buildCodingMaster(r.map, { ExcelJS });
    saveBlob('Service_Coding_Master.xlsx', new Blob([buf], { type: XLSX_TYPE }));
    state.master = r.map; state.edits = new Map(); setCodingPill();
    st.textContent = `Downloaded Service_Coding_Master.xlsx: ${r.map.size.toLocaleString('en-US')} services, ${r.added} new, ${r.changed} with changed codes. Save it over the copy on the shared drive.`;
  } catch (e) { st.textContent = `The coding master could not be built: ${(e && e.message) || e}`; }
  b.disabled = false;
});

''' + S[b:]
R("$('opt-pending').addEventListener('change', () => { if (prepared) { resetPrepared(); $('dl-status').textContent = 'Option changed – prepare the Excel report again.'; } });", "")

# ---- coding editor: in-page edits
R("  const rows = A.services.map((s) => ({ s, c: state.coding.get(s.key) || {} }))", "  const eff = effectiveCoding();\n  const rows = A.services.map((s) => ({ s, c: eff.get(s.key) || {} }))")
R("  const coded = A.services.filter((s) => { const c = state.coding.get(s.key) || {}; return c.csi || c.mnl || c.cec; }).length;",
  "  const coded = A.services.filter((s) => { const c = eff.get(s.key) || {}; return c.csi || c.mnl || c.cec; }).length;")
R("""  const ro = !state.db;
  $('cd-status').textContent = ro ? 'Shared coding is not available in this view, so the boxes are read-only.' : '';""", "  const ro = false;")
a = S.index("  const missingFromShared = state.prev ?")
b = S.index("$('tb-coding').addEventListener('change', async (e) => {")
S = S[:a] + "}\n" + S[b:]
a = S.index("$('tb-coding').addEventListener('change', async (e) => {")
b = S.index("// redraw charts when the theme changes")
S = S[:a] + '''$('tb-coding').addEventListener('change', (e) => {
  const inp = e.target; if (!inp.classList.contains('code')) return;
  const tr = inp.closest('tr'); const k = E.codingKey(tr.dataset.svc, tr.dataset.text);
  const cur = Object.assign({}, state.edits.get(k) || {}); cur[inp.dataset.f] = inp.value.trim(); state.edits.set(k, cur);
  inp.classList.add('saved'); setCodingPill();
  $('cd-status').textContent = `${state.edits.size} unsaved edit${state.edits.size === 1 ? '' : 's'} – download the updated coding master to keep them.`;
});
window.addEventListener('beforeunload', (e) => { if (state.edits.size) { e.preventDefault(); e.returnValue = ''; } });

''' + S[b:]

# ==== stage 2: work package coding (Package / MNL / Cost element) replaces the free-text coding tab
a = S.index('<div id="view-coding" role="tabpanel" aria-labelledby="tab-coding" hidden>')
b = S.index('<div id="view-checks"')
S = S[:a] + """<div id="view-coding" role="tabpanel" aria-labelledby="tab-coding" hidden>
          <div class="card"><div class="hd"><h3>Work package coding</h3><span class="muted" style="font-size:12px" id="wp-summary"></span></div>
            <div class="bd">
              <div class="coding-tools">
                <input type="search" id="wp-filter" placeholder="Filter by code, description, PO or supplier" aria-label="Filter rows">
                <label class="muted wpo"><input type="checkbox" id="wp-open"> Only unallocated</label>
                <span class="segs vw" role="group" aria-label="View"><button class="seg" data-view="svc">Services</button><button class="seg" data-view="po">By PO</button><button class="seg" data-view="sup">By supplier</button></span>
                <label class="muted wpo" id="wp-g1l">Group by <select id="wp-g1"><option value="svcgroup">Service group (S04)</option><option value="month">Month</option><option value="package">Package</option><option value="mnl">MNL</option><option value="cec">Cost element</option></select></label>
                <label class="muted wpo" id="wp-g2l">Then by <select id="wp-g2"><option value="none">—</option><option value="month">Month</option><option value="svcgroup">Service group</option><option value="package">Package</option><option value="mnl">MNL</option><option value="cec">Cost element</option></select></label>
                <button id="wp-expand">Expand all</button><button id="wp-collapse">Collapse all</button>
                <button class="primary" id="btn-master">Download work package master</button>
                <button id="btn-savetool" title="Download this tool with the current Package, MNL and Cost element lists built in – replace your copy with it">💾 Save tool</button>
              </div>
              <div class="wpperiod" role="group" aria-label="Time frame">
                <span class="plab">Period</span><span class="pills" id="wp-pills"></span><span class="psep"></span>
                <span class="pdate"><span class="plab">Date</span><input type="date" id="wp-from" aria-label="From date"><span class="muted">→</span><input type="date" id="wp-to" aria-label="To date"></span>
                <span class="pstate" id="wp-pstate">All data shown</span><button id="wp-pclear" hidden>Clear</button>
              </div>
              <div class="status" id="wp-status" style="margin-top:0"></div>
              <div class="wpbar" id="wp-bar"></div>
              <div id="wp-host"></div>
              <div class="note">Codes are stored per project on service code + service text. <b>Services</b> lists each service once – click its PO count to see the POs behind it. In <b>By PO</b> and <b>By supplier</b>, coding a row codes that service on every PO. Dashed badges are suggestions; they count only after you accept them. Download the work package master to keep your coding, then build the Excel report again to include it.</div>
            </div>
          </div>
        </div>

        """ + S[b:]
R("const state = { files: {}, prev: null, master: new Map(), masterName: null, edits: new Map(), analysis: null, summary: null, charts: {} };",
  "const state = { files: {}, prev: null, wp: E.defaultMaster(), wpDirty: false, plant: null, masterName: null, edits: new Map(), analysis: null, summary: null, charts: {} };")
a = S.index("function effectiveCoding() {"); b = S.index("function saveBlob(name, blob) {")
S = S[:a] + """function effectiveCoding() {
  // this project's work package coding, with last month's report filling any field the master leaves empty
  const m = prevCodes(); const wp = E.codingFor(state.wp, state.plant || '');
  for (const [k, v] of wp) { const o = m.get(k) || {}; m.set(k, { unit: v.unit || o.unit || '', csi: v.csi || o.csi || '', mnl: v.mnl || o.mnl || '', cec: v.cec || o.cec || '' }); }
  return m;
}
function setCodingPill() {
  const pr = state.plant; const pre = (pr || '') + '\\u0001';
  const mine = pr ? [...state.wp.mapping.keys()].filter((k) => k.startsWith(pre)).length : 0;
  $('dot-coding').className = 'dot ' + (state.masterName || state.wp.mapping.size ? 'on' : 'off');
  $('txt-coding').textContent = (state.masterName ? `Work package master: ${state.wp.mapping.size.toLocaleString('en-US')} codings` : 'Work package master: not loaded') +
    (pr ? ` · ${pr} ${mine.toLocaleString('en-US')}` : '') + (state.wpDirty ? ' · unsaved changes' : '');
}
""" + S[b:]
R("""      if (wb.SheetNames.includes(E.MASTER_SHEET)) {
        state.master = E.readCodingMaster(XLSX.utils.sheet_to_json(wb.Sheets[E.MASTER_SHEET], { header: 1, raw: true, defval: '' })); state.masterName = f.name;
        const coded = [...state.master.values()].filter((e) => e.csi || e.mnl || e.cec).length;
        setSlot('master', f.name, `${state.master.size.toLocaleString('en-US')} services · ${coded.toLocaleString('en-US')} with codes`); setCodingPill();
        continue;
      }""",
"""      if (wb.SheetNames.includes('Service Mapping') || wb.SheetNames.includes(E.MASTER_SHEET)) {
        const sh = {}; for (const n of wb.SheetNames) sh[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
        state.wp = E.readMaster(sh); state.masterName = f.name; state.wpDirty = false; CodingUI.reset();
        const prj = new Set([...state.wp.mapping.keys()].map((k) => k.split('\\u0001')[0]));
        setSlot('master', f.name, `${state.wp.mapping.size.toLocaleString('en-US')} codings · ${prj.size} project${prj.size === 1 ? '' : 's'}` + (state.wp.migrated ? ` · ${state.wp.migrated} brought over from the old master` : '') + (state.wp.dropped ? ` · ${state.wp.dropped} codings on deleted packages are unallocated again` : ''));
        setCodingPill(); continue;
      }""")
R("""      if (kind === 'prog') { state.files.prog = aoa; state.files.progName = f.name;
        const plants = new Set(aoa.slice(1, 200).map((r) => String(r[0]).trim()).filter((x) => x && !x.includes('(')));""",
"""      if (kind === 'prog') { state.files.prog = aoa; state.files.progName = f.name;
        const plants = new Set(aoa.slice(1, 200).map((r) => String(r[0]).trim()).filter((x) => x && !x.includes('(')));
        const pc = new Map(); for (const r of aoa.slice(1)) if (String(r[4]).trim()) { const p = String(r[0]).trim(); pc.set(p, (pc.get(p) || 0) + 1); }
        state.plant = [...pc].sort((a, b) => b[1] - a[1])[0]?.[0] || null; CodingUI.reset(); setCodingPill(); fillMonths(aoa);""")
R("$('btn-clear').addEventListener('click', () => {", """$('opt-month').addEventListener('change', () => { if (state.analysis) $('btn-build').click(); });
$('btn-clear').addEventListener('click', () => {""")
R("  return E.analyse(state.files.prog, state.files.serv, { coding: mergedCoding(), history: state.prev, pendingInMonth: $('opt-pending').checked,",
  "  return E.analyse(state.files.prog, state.files.serv, { coding: mergedCoding(), master: state.wp, history: state.prev, cutMonth: +$('opt-month').value || undefined,")
R("    resetPrepared(); $('dl-status').textContent = '';", "    resetPrepared(); $('dl-status').textContent = ''; CodingUI.reset();")
a = S.index("$('btn-master').addEventListener('click', async () => {"); b = S.index("// ---------------------------------------------------------------- tabs")
S = S[:a] + """$('btn-master').addEventListener('click', async () => {
  const st = $('wp-status'); const b = $('btn-master'); b.disabled = true;
  try {
    const buf = await E.buildMaster(state.wp, { ExcelJS });
    saveBlob('Work_Package_Master.xlsx', new Blob([buf], { type: XLSX_TYPE }));
    state.wpDirty = false; setCodingPill();
    st.textContent = `Downloaded Work_Package_Master.xlsx (${state.wp.mapping.size.toLocaleString('en-US')} codings). Save it over the copy on the shared drive.`;
  } catch (e) { st.textContent = `The master could not be built: ${(e && e.message) || e}`; }
  b.disabled = false;
});

""" + S[b:]
R("if (name === 'coding') renderCoding();", "if (name === 'coding') CodingUI.render();")
a = S.index("let codingFilter = '';"); b = S.index("// redraw charts when the theme changes")
S = S[:a] + open('coding_ui.js').read() + """
CodingUI.mount();
window.addEventListener('beforeunload', (e) => { if (state.wpDirty) { e.preventDefault(); e.returnValue = ''; } });

""" + S[b:]
R('<button id="btn-master">Download updated coding master</button>', '', 0) if False else None
R("<li>CSI, MNL and Cost Element Code come from the coding master on your shared drive. Edit them on the Service coding tab and download the updated master.</li>",
  "<li>Package (CSI division), MNL and Cost Element come from the work package master on your shared drive. Code them in bulk on the Coding tab and download the updated master.</li>")
R('<button role="tab" id="tab-coding" aria-selected="false" aria-controls="view-coding">Service coding</button>','<button role="tab" id="tab-coding" aria-selected="false" aria-controls="view-coding">Coding</button>')
R("Service_Coding_Master.xlsx — optional</span><span class=\"meta\" id=\"meta-master\">Team codes from the shared drive</span>",
  "Work_Package_Master.xlsx — optional</span><span class=\"meta\" id=\"meta-master\">Package, MNL and Cost Element codes from the shared drive</span>")
R("['master', 'Service_Coding_Master.xlsx — optional', 'Team codes from the shared drive']","['master', 'Work_Package_Master.xlsx — optional', 'Package, MNL and Cost Element codes from the shared drive']")
R("state.files = {}; state.prev = null; state.analysis = null; state.master = new Map(); state.masterName = null; setCodingPill();",
  "state.files = {}; state.prev = null; state.analysis = null; state.wp = E.defaultMaster(); state.masterName = null; state.plant = null; state.wpDirty = false; CodingUI.reset(); setCodingPill();")
R("  $('btn-clear').disabled = !(state.files.prog || state.files.serv || state.prev || state.master.size);","  $('btn-clear').disabled = !(state.files.prog || state.files.serv || state.prev || state.masterName);")
R("<span class=\"pill\" id=\"pill-coding\"><i class=\"dot\" id=\"dot-coding\"></i><span id=\"txt-coding\">Coding master: not loaded</span></span>",
  "<span class=\"pill\" id=\"pill-coding\"><i class=\"dot\" id=\"dot-coding\"></i><span id=\"txt-coding\">Work package master: not loaded</span></span>")
R('</style>', """/* ---- work package coding ---- */
.wpo{font-size:12px;display:flex;gap:6px;align-items:center}
.wpo select{font:inherit;padding:4px 6px;border:1px solid var(--line-2);border-radius:6px;background:var(--panel);color:var(--ink)}
.wpbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--gold);border-radius:8px;padding:8px 10px;margin:8px 0;font-size:13.5px;box-shadow:0 2px 6px rgba(15,42,82,.08)}
.wpbar .segs{display:inline-flex;border:1px solid var(--line-2);border-radius:7px;overflow:hidden}
.wpbar .seg{border:0;border-radius:0;padding:5px 11px;background:var(--panel);font-size:12.5px}
.wpbar .seg.on{background:var(--navy);color:#fff}
.wpbar .picks{display:flex;flex-wrap:wrap;gap:4px;flex:1 1 420px}
#wp-clear{padding:4px 10px;font-size:12px}
.pick{padding:2px 7px;font-size:11.5px;border-radius:999px;border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 8%,var(--panel));color:var(--ink);font-family:var(--mono)}
.pick.on,.pick:hover{background:var(--c);color:#fff;border-color:var(--c)}
.pick i,.wpb i,.wps i{font-style:normal;margin-right:3px}
.wpbar .acc{background:var(--gold);border-color:var(--gold);color:#0F2A52;font-weight:600}
.newce{display:inline-flex;gap:4px}.newce input{font:12px var(--mono);width:90px;padding:4px 6px;border:1px solid var(--line-2);border-radius:6px;background:var(--panel);color:var(--ink)}
.newce input+input{width:140px;font-family:var(--sans)}
#wp-host{overflow:visible}
.wpt{font-size:12.5px}
.wpt thead th{position:sticky;top:var(--sel-bar-h,52px);z-index:4}
.wpt th[data-sort]{cursor:pointer}
.wpt th.on{box-shadow:inset 0 -3px 0 var(--gold)}
.wpt td.ck,.wpt th.ck{width:28px;text-align:center}
.wpg td{background:var(--accent-soft);border-bottom:1px solid var(--line-2)}
.wpg.l2 td{background:var(--panel-2)}.wpg.l2 td:nth-child(2){padding-left:26px}
.wpc{border:0;background:none;padding:0 6px 0 0;font-size:12px;color:var(--muted);cursor:pointer}
.wpl.sel td{background:color-mix(in srgb,var(--gold) 12%,var(--panel))}
.wpt td.bd{white-space:nowrap}
.wpb,.wps,.wpu{display:inline-flex;align-items:center;font:11.5px var(--mono);padding:1px 7px;border-radius:999px;white-space:nowrap}
.wpb{background:color-mix(in srgb,var(--c) 14%,var(--panel));color:var(--c);border:1px solid color-mix(in srgb,var(--c) 35%,transparent);font-weight:600}
.wps{border:1px dashed var(--c);color:var(--muted);background:transparent}
.wpu{background:var(--warn-soft);color:var(--warn);font-weight:700;font-size:10.5px;letter-spacing:.03em}
.wpx{border:0;background:none;color:var(--muted);padding:0 0 0 4px;font-size:11px;cursor:pointer}.wpx:hover{color:var(--bad)}
.meter{display:inline-block;vertical-align:middle;width:70px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--warn) 22%,transparent);overflow:hidden}
.meter i{display:block;height:100%;background:var(--warn)}
.meter.full{background:color-mix(in srgb,var(--good) 22%,transparent)}.meter.full i{background:var(--good)}
.wpperiod{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:8px 12px;margin:0 0 8px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.wpperiod .plab{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-right:2px}
.wpperiod .pills{display:flex;flex-wrap:wrap;gap:5px}
.pp{padding:3px 11px;font-size:12px;font-weight:600;border-radius:999px;border:1px solid var(--line-2);background:var(--panel-2);color:var(--ink)}
.pp.ex{font-style:italic;font-weight:500}
.pp:hover{border-color:var(--navy)}
.pp.on{background:var(--navy);border-color:var(--navy);color:#fff}
.wpperiod .psep{width:1px;align-self:stretch;background:var(--line-2);margin:0 4px}
.wpperiod input[type=date]{font:12px var(--sans);padding:4px 6px;border:1px solid var(--line-2);border-radius:6px;background:var(--panel);color:var(--ink)}
.wpperiod .pstate{margin-left:auto;font-size:12px;color:var(--muted)}
#wp-pclear{padding:3px 10px;font-size:12px}
.wpperiod .pdate{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.pon{color:var(--ink);font-weight:600}
.segs.vw{display:inline-flex;border:1px solid var(--line-2);border-radius:7px;overflow:hidden}
.segs.vw .seg{border:0;border-radius:0;padding:6px 12px;background:var(--panel);font-size:12.5px}
.segs.vw .seg.on{background:var(--navy);color:#fff}
.wpd{border:1px solid var(--line-2);background:var(--panel-2);border-radius:999px;padding:1px 9px;font:600 11.5px var(--mono);color:var(--ink);cursor:pointer}
.wpd[aria-expanded=true]{background:var(--navy);color:#fff;border-color:var(--navy)}
.wpo2{font:11.5px var(--mono);color:var(--muted)}
.wpsub td{background:var(--panel-2);font-size:12px;border-bottom:1px dashed var(--line-2)}
.wpsub td:nth-child(2){padding-left:30px}
.rdiff{color:var(--warn);font-weight:700}
.wpedit{padding:4px 10px;font-size:12px;border:1px dashed var(--line-2);background:var(--panel);border-radius:6px;cursor:pointer}.wpedit:hover{border-color:var(--navy)}
dialog.wped{border:1px solid var(--line-2);border-radius:10px;padding:0;max-width:880px;width:94vw;background:var(--panel);color:var(--ink);box-shadow:0 18px 50px rgba(15,42,82,.35)}
dialog.wped::backdrop{background:rgba(15,42,82,.35)}
.wped form{padding:16px 18px}.wped h3{margin:0 0 4px;color:var(--navy)}.wped p{margin:0 0 10px;font-size:12.5px}
.wped-scroll{max-height:55vh;overflow:auto;border:1px solid var(--line);border-radius:8px}
.wped-t{width:100%;border-collapse:collapse;font-size:12.5px}.wped-t th{position:sticky;top:0;background:var(--navy);color:#fff;text-align:left;padding:6px 8px;font-weight:600}
.wped-t td{padding:4px 6px;border-bottom:1px solid var(--line)}.wped-t input{width:100%;font:inherit;padding:4px 6px;border:1px solid var(--line-2);border-radius:5px;background:var(--panel);color:var(--ink)}
.wped-t input.ic{width:46px;text-align:center}.wped-t td.r{text-align:right}.wped-t tr.del td{opacity:.45;text-decoration:line-through}
.wped-t .mv button{padding:1px 5px;font-size:10px;margin-right:2px}.wped-t button.x{color:var(--bad);border-color:transparent;background:none}
.wped-add{display:flex;gap:10px;align-items:center;margin-top:10px}.wped-msg{color:var(--bad);font-size:12.5px;font-weight:600}
.wped-act{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.warnx{color:var(--warn);font-weight:600}.goodx{color:var(--good);font-weight:600}
</style>""")

# ---- codes typed in last month's report come into the tool's coding (and so the next report and the master)
R("        state.prev = E.readPrevious(by); state.files.prevName = f.name;",
  "        state.prev = E.readPrevious(by); state.prev.savedAt = f.lastModified ? new Date(f.lastModified) : null; state.files.prevName = f.name;")
R("""  setStatus('');
  $('btn-build').disabled = !(state.files.prog && state.files.serv);""", """  setStatus('');
  applyPrevCoding();
  $('btn-build').disabled = !(state.files.prog && state.files.serv);""")
R("""    if (v.csi || v.mnl || v.cec || own) m.set(k, { unit: own ? v.unit : '', csi: v.csi || '', mnl: v.mnl || '', cec: v.cec || '' });""",
  """    const csi = state.wp.packages.some((p) => p.code === v.csi) ? v.csi : '', mnl = state.wp.mnl.some((x) => x.code === v.mnl) ? v.mnl : '';   // a code not in the lists stays unallocated
    if (csi || mnl || v.cec || own) m.set(k, { unit: own ? v.unit : '', csi, mnl, cec: v.cec || '' });""")
R("function saveBlob(name, blob) {", """function applyPrevCoding() {
  // runs once per (report, master, project): loading a master afterwards replaces state.wp, so the report's codes go in again
  if (!state.prev) return; const pr = state.plant || state.prev.project; if (!pr) return;
  const sig = state.files.prevName + '|' + pr; if (state.wp._prevSig === sig) return; state.wp._prevSig = sig;
  const r = E.adoptPrevious(state.wp, pr, state.prev.coding, state.prev.savedAt);
  const n = r.added + r.changed;
  if (n) { state.wpDirty = true; CodingUI.reset(); }
  setCodingPill();
  message('msgs', n || !state.prev.coding.size ? 'good' : 'warn', n
    ? `Coding from ${state.files.prevName}: ${r.added.toLocaleString('en-US')} codes filled in` + (r.changed ? `, ${r.changed.toLocaleString('en-US')} changed to what the report says` : '') + ` for ${pr}. Download the work package master to keep them.`
    : `${state.files.prevName}: no codes to bring in – its Service Coding sheet has no Package / MNL / Cost element typed, or they match the master already.`);
  if (r.keptNewer) message('msgs', 'warn', `${r.keptNewer} code${r.keptNewer === 1 ? '' : 's'} in the report differ from the master, which was changed later – the master's code is kept.`);
  if (r.unknown) message('msgs', 'warn', `${r.unknown} code${r.unknown === 1 ? '' : 's'} in the report are not in the lists (${[...r.unknownCodes].slice(0, 6).join(', ')}) – left unallocated. Add them with ✎ Edit list and load the report again.`);
}
function saveBlob(name, blob) {""")

# ---- Save tool: the page downloads itself with the edited lists built in.
# The snapshot is taken just before the app script runs, so it is the page as shipped (nothing rendered yet).
R("""</script>
<script>
(function(){
'use strict';""", """</script>
<script type="application/json" id="tool-lists">null</script>
<script id="tool-snap">window.__TOOL_SNAP__ = document.documentElement.outerHTML;
try { const t = localStorage.getItem('scr-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
try { const l = JSON.parse(document.getElementById('tool-lists').textContent); if (l) SubcontractEngine.setBase(l); } catch (e) {}</script>
<script id="app-main">
(function(){
'use strict';""")
R("function saveBlob(name, blob) {", """function saveTool() {
  const snap = window.__TOOL_SNAP__ || '', app = $('app-main'); const cut = snap.indexOf('<script id="tool-snap">'), end = snap.indexOf('<\\/script>', cut);
  if (cut < 0 || end < 0 || !app) throw new Error('this copy of the tool cannot save itself');
  const json = JSON.stringify(E.listsOf(state.wp)).replace(/</g, '\\\\u003c');
  const head = snap.slice(0, end + 9).replace(/(<script type="application\/json" id="tool-lists">)[\s\S]*?(<\/script>)/, (m, a, b) => a + json + b);
  const html = '<!DOCTYPE html>\\n' + head + '\\n' + app.outerHTML + '\\n</body>\\n</html>\\n';
  const name = decodeURIComponent((location.pathname.split('/').pop() || '')) || 'Subcontract_Cost_Report.html';
  saveBlob(/\.html?$/i.test(name) ? name : 'Subcontract_Cost_Report.html', new Blob([html], { type: 'text/html' }));
  state.toolDirty = false; const b = $('btn-savetool'); if (b) b.classList.remove('dirty');
  return name;
}
function saveBlob(name, blob) {""")
R("$('btn-master').addEventListener('click', async () => {", """$('btn-savetool').addEventListener('click', () => {
  const st = $('wp-status');
  try { const n = saveTool(); st.textContent = `Saved the tool with your lists (${state.wp.packages.length} packages, ${state.wp.mnl.length} MNL). Replace your old ${n} with the downloaded file – it opens with these lists from now on.`; }
  catch (e) { st.textContent = `The tool could not be saved: ${(e && e.message) || e}`; }
});
$('btn-master').addEventListener('click', async () => {""")
R(".warnx{color:var(--warn);font-weight:600}", "#btn-savetool.dirty{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft);font-weight:700}.wped-t button.ins{padding:2px 8px;font-size:11.5px;white-space:nowrap}\n.warnx{color:var(--warn);font-weight:600}")

# ---- light / dark switch (default follows the computer; the choice is remembered in this browser)
R("""    <div class="pillrow">
      <span class="pill" id="pill-coding">""", """    <div class="pillrow">
      <button class="pill themebtn" id="btn-theme" type="button"></button>
      <span class="pill" id="pill-coding">""")
R("function saveBlob(name, blob) {", """function themeNow() { const t = document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function themeLabel() { const b = $('btn-theme'); const dark = themeNow() === 'dark';
  b.textContent = dark ? '☀️ Light mode' : '🌙 Dark mode'; b.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme'; b.setAttribute('aria-pressed', dark); }
$('btn-theme').addEventListener('click', () => { const t = themeNow() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; try { localStorage.setItem('scr-theme', t); } catch (e) {} themeLabel(); });
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeLabel); } catch (e) {}
themeLabel();
function saveBlob(name, blob) {""")
R(".warnx{color:var(--warn);font-weight:600}", "header.top .pill.themebtn{cursor:pointer;font:inherit;font-size:12px;font-weight:600;color:#fff}header.top .pill.themebtn:hover{background:rgba(255,255,255,.14)}\n.warnx{color:var(--warn);font-weight:600}")

# ---- embed libraries
libs = [('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'node_modules/xlsx/dist/xlsx.full.min.js'),
        ('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js', 'node_modules/exceljs/dist/exceljs.min.js'),
        ('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', 'node_modules/jszip/dist/jszip.min.js'),
        ('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js', 'node_modules/chart.js/dist/chart.umd.js')]
for url, path in libs:
    code = open(path, encoding='utf-8').read().replace('</script', '<\\/script')
    code = re.sub(r'//# sourceMappingURL=\S+', '', code)
    R(f'<script src="{url}"></script>', '<script>' + code + '</script>')
eng = open('engine.js').read()
assert '</script' not in eng
R('/*ENGINE*/', eng)
leftover = [u for u in re.findall(r'https?://[^\s"\')]+', S) if 'fonts.g' in u or 'jsdelivr' in u or 'cdnjs' in u]
assert not leftover, leftover
out = '<!doctype html>\n<html lang="en">\n<head>\n' + S.replace('<style>', '<style>', 1)
# head/body split: everything up to </style> in head
i = out.index('</style>') + len('</style>')
out = out[:i] + '\n</head>\n<body>\n' + out[i:] + '\n</body>\n</html>\n'
open(sys.argv[1], 'w', encoding='utf-8').write(out)
print('written', sys.argv[1], round(len(out.encode()) / 1048576, 2), 'MB')
