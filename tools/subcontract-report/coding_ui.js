// ---------------------------------------------------------------- work package coding page
// A code is stored on (project, service code, service text). Three views over the same lines:
//   svc – one row per service (the unique list that gets coded), its POs one click away;
//   po  – PO → its services;  sup – supplier → PO → services.
// In the PO views coding a row still codes that service on every PO. Three dimensions share one picker.
const CodingUI = (() => {
  const ui = { view: 'svc', drill: new Set(), dim: 'package', g1: 'svcgroup', g2: 'none', sort: { col: 'amount', dir: -1 }, filter: '', onlyOpen: false,
    selected: new Set(), collapsed: new Set(), fold: 0, rows: [], byId: new Map(),
    lines: null, period: new Set(), from: 0, to: 0, sig: null };
  const DIMS = E.DIMS;
  const cat = () => {
    const wp = state.wp, pr = state.plant || '';
    return {
      package: wp.packages.map((p) => ({ code: p.code, label: p.label, icon: p.icon, color: p.color, group: p.group })),
      mnl: wp.mnl.map((m) => ({ code: m.code, label: m.label, icon: '', color: '4A6FA5' })),
      cec: [...(wp.costElements.get(pr) || new Map())].map(([code, label]) => ({ code, label: label || code, icon: '', color: '7A5C9E' })),
    };
  };
  const findCat = (dim, code) => cat()[dim].find((x) => x.code === code);
  const current = (svc, text) => state.wp.mapping.get(E.mkey(state.plant, svc, text)) || {};

  // Time frame: every certificate line keeps its report bucket (Opening, a month, Pending) and its date.
  // Rows are re-aggregated from the lines for the selected periods; with Month as a grouping a row is
  // split per month, so each month shows what was certified in it.
  const bkey = (b) => (b === 'OPENING' ? '000000' : b === 'PENDING' ? '999999' : String(b));
  const blabel = (k) => (k === '000000' ? 'Opening' : k === '999999' ? 'Pending' : E.mlabel(+k).replace('-', ' '));
  const dkey = (v) => (v ? +v.replace(/-/g, '') : 0);
  function build() {
    const A = state.analysis; if (!A) { ui.lines = []; ui.rows = []; ui.periods = []; return; }
    ui.lines = A.det.map((r) => ({ id: r.po + '\u0001' + r.svc + '\u0001' + r.text, po: r.po, sup: r.supName, svc: r.svc, text: r.text,
      key: E.codingKey(r.svc, r.text), b: bkey(r.bucket), d: r.dateKey, amt: r.amt, qty: r.repq || 0 }));
    ui.keyPOs = new Map(); for (const l of ui.lines) { if (!ui.keyPOs.has(l.key)) ui.keyPOs.set(l.key, new Set()); ui.keyPOs.get(l.key).add(l.po); }
    ui.unit = A.svu || new Map();
    const per = new Map(); for (const l of ui.lines) per.set(l.b, (per.get(l.b) || 0) + l.amt);
    ui.periods = [...per].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    ui.period = new Set([...ui.period].filter((k) => per.has(k)));
    ui.allTotal = ui.lines.reduce((a, l) => a + l.amt, 0);
    ui.sugg = E.suggest(A, state.wp); ui.sig = null;
  }
  // effective grouping for the current view
  const eff = () => ui.view === 'po' ? { g1: 'po', g2: 'none' } : ui.view === 'sup' ? { g1: 'supplier', g2: 'po' }
    : { g1: ui.g1, g2: ui.g2 === ui.g1 ? 'none' : ui.g2 };
  const byMonth = () => ui.view === 'svc' && (ui.g1 === 'month' || level2() === 'month');
  const inPeriod = (l) => (!ui.period.size || ui.period.has(l.b)) && (!ui.from || l.d >= ui.from) && (!ui.to || l.d <= ui.to);
  function aggregate() {
    if (!ui.lines) build();
    const bm = byMonth(), sv = ui.view === 'svc', sig = [ui.view, bm, [...ui.period].join(), ui.from, ui.to, ui.lines.length].join('|');
    if (sig === ui.sig) return; ui.sig = sig;
    const m = new Map();
    for (const l of ui.lines) {
      if (!inPeriod(l)) continue;
      const base = sv ? l.key : l.id, id = bm ? base + '\u0003' + l.b : base;
      let x = m.get(id);
      if (!x) { x = { id, po: sv ? '' : l.po, sup: sv ? '' : l.sup, svc: l.svc, text: l.text, key: l.key, b: bm ? l.b : '', lines: 0, amount: 0, qty: 0, pos: new Map() }; m.set(id, x); }
      x.lines++; x.amount += l.amt; x.qty += l.qty;
      let p = x.pos.get(l.po); if (!p) { p = { po: l.po, sup: l.sup, lines: 0, qty: 0, amount: 0 }; x.pos.set(l.po, p); }
      p.lines++; p.qty += l.qty; p.amount += l.amt;
    }
    for (const x of m.values()) {
      x.unit = ui.unit.get(x.svc) || ''; x.npo = x.pos.size; x.rate = x.qty ? x.amount / x.qty : null;
      x.others = Math.max(0, (ui.keyPOs.get(x.key) || new Set()).size - 1);
      x.find = (x.svc + ' ' + x.text + ' ' + [...x.pos.values()].map((p) => p.po + ' ' + p.sup).join(' ')).toLowerCase();
    }
    ui.rows = [...m.values()]; ui.byId = m;
    ui.total = ui.rows.reduce((a, r) => a + r.amount, 0);
    for (const id of [...ui.selected]) if (!m.has(id)) ui.selected.delete(id);
  }
  const codeOf = (r, dim) => (current(r.svc, r.text)[dim] || '');
  const groupKey = (r, g) => {
    if (g === 'svcgroup') return r.svc.slice(0, 3);
    if (g === 'po') return r.po;
    if (g === 'supplier') return r.sup;
    if (g === 'month') return r.b;
    if (g === 'none') return '';
    return codeOf(r, g) || '￿';          // unallocated sorts last
  };
  const groupLabel = (g, k, sample) => {
    if (g === 'svcgroup') { const t = sample.svc[0] === 'S' ? sample.svc.slice(1, 3) : sample.svc[0]; return `${k} · ${E.tradeName(t)}`; }
    if (g === 'po') return ui.view === 'sup' ? `PO ${k}` : `PO ${k} · ${sample.sup}`;
    if (g === 'supplier') return k || '(no supplier)';
    if (g === 'month') return blabel(k);
    if (k === '￿') return `UNALLOCATED ${DIMS[g]}`;
    const c = findCat(g, k); return c ? `${c.icon ? c.icon + ' ' : ''}${c.code} · ${c.label}` : k;
  };
  const groupOrder = (g, keys, totals) => {
    if (g === 'month') return keys.sort();          // time always runs forward
    const byTotal = ui.sort.col === 'amount' || ui.sort.col === 'lines';
    if (byTotal) return keys.sort((a, b) => ui.sort.dir * ((totals.get(a)[ui.sort.col]) - (totals.get(b)[ui.sort.col])));
    if (g === 'package' || g === 'mnl' || g === 'cec') { const order = cat()[g].map((c) => c.code); return keys.sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999)); }
    return keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };
  function visibleRows() {
    const f = ui.filter;
    return ui.rows.filter((r) => (!f || r.find.includes(f)) && (!ui.onlyOpen || !codeOf(r, ui.dim)));
  }
  const sortRows = (rows) => {
    const c = ui.sort.col, d = ui.sort.dir;
    const num = c === 'lines' || c === 'qty' || c === 'amount' || c === 'rate' || c === 'npo';
    return rows.sort((a, b) => { const x = a[c], y = b[c]; return d * (num ? (x ?? -Infinity) - (y ?? -Infinity) || 0 : String(x).localeCompare(String(y))); });
  };

  // ---------- badges
  function badge(r, dim) {
    const code = codeOf(r, dim);
    if (code) { const c = findCat(dim, code) || { code, label: code, icon: '', color: '6B7280' };
      return `<span class="wpb" style="--c:#${c.color}" title="${esc(DIMS[dim] + ': ' + c.code + ' – ' + c.label)}">${c.icon ? `<i>${c.icon}</i>` : ''}${esc(c.code)}</span><button class="wpx" data-undo="${esc(r.id)}" data-dim="${dim}" title="Remove this ${DIMS[dim]} code" aria-label="Remove ${DIMS[dim]} code">✕</button>`; }
    const s = (ui.sugg.get(r.key) || {})[dim];
    if (s) { const c = findCat(dim, s[0]) || { code: s[0], icon: '', color: '6B7280' };
      return `<span class="wps" style="--c:#${c.color}" title="Suggested: ${esc(c.code)} (${esc(s[1])}) – select the row and press Accept">${c.icon ? `<i>${c.icon}</i>` : ''}${esc(c.code)}?</span>`; }
    return '<span class="wpu">UNALLOCATED</span>';
  }

  // ---------- render
  function render() {
    const host = $('wp-host'); if (!host) return;
    if (!state.analysis) { host.innerHTML = '<p class="muted">Build a report first.</p>'; return; }
    aggregate(); renderPeriod();
    const dim = ui.dim, rows = sortRows(visibleRows());
    // count each service once, whatever the view or month split
    const all = [...new Map(ui.rows.map((r) => [r.key, r])).values()], coded = all.filter((r) => codeOf(r, dim)), open = all.length - coded.length;
    const openAmt = ui.rows.filter((r) => !codeOf(r, dim)).reduce((a, r) => a + r.amount, 0);
    $('wp-summary').innerHTML = `${(all.length - open).toLocaleString('en-US')} of ${all.length.toLocaleString('en-US')} services coded on <b>${DIMS[dim]}</b> · <span class="${open ? 'warnx' : 'goodx'}">${open.toLocaleString('en-US')} unallocated (${ui.total ? (openAmt / ui.total * 100).toFixed(1) : '0.0'}% of total spend)</span>`;
    // groups (two levels)
    const { g1, g2 } = eff();
    const tree = new Map();
    for (const r of rows) { const a = groupKey(r, g1), b = g2 === 'none' ? '' : groupKey(r, g2);
      if (!tree.has(a)) tree.set(a, new Map()); const t = tree.get(a); if (!t.has(b)) t.set(b, []); t.get(b).push(r); }
    const totalsOf = (list) => ({ amount: list.reduce((x, r) => x + r.amount, 0), lines: list.reduce((x, r) => x + r.lines, 0) });
    const t1 = new Map([...tree].map(([k, t]) => [k, totalsOf([...t.values()].flat())]));
    let html = '';
    for (const k1 of groupOrder(g1, [...tree.keys()], t1)) {
      const sub = tree.get(k1); const list1 = [...sub.values()].flat();
      html += groupRow(1, g1, k1, list1, k1);
      if (ui.collapsed.has('1' + k1)) continue;
      const t2 = new Map([...sub].map(([k, l]) => [k, totalsOf(l)]));
      for (const k2 of (g2 === 'none' ? [''] : groupOrder(g2, [...sub.keys()], t2))) {
        const list2 = sub.get(k2);
        if (g2 !== 'none') { html += groupRow(2, g2, k2, list2, k1 + '\u0002' + k2); if (ui.collapsed.has('2' + k1 + '\u0002' + k2)) continue; }
        for (const r of list2) { html += leafRow(r); if (ui.view === 'svc' && ui.drill.has(r.id)) html += drillRows(r); }
      }
    }
    const sortMark = (c) => ui.sort.col === c ? (ui.sort.dir > 0 ? ' ▲' : ' ▼') : '';
    const visIds = rows.map((r) => r.id); const selVis = visIds.filter((id) => ui.selected.has(id)).length;
    host.innerHTML = `<table class="wpt"><thead><tr>
      <th class="ck"><input type="checkbox" id="wp-all" aria-label="Select all visible rows" ${selVis && selVis === visIds.length ? 'checked' : ''}></th>
      <th data-sort="svc">Service code${sortMark('svc')}</th><th data-sort="text">Description${sortMark('text')}</th><th>Unit</th>
      <th class="r" data-sort="npo">${ui.view === 'svc' ? 'POs' : 'Also on'}${sortMark('npo')}</th>
      <th class="r" data-sort="lines">Lines${sortMark('lines')}</th><th class="r" data-sort="qty">Qty${sortMark('qty')}</th><th class="r" data-sort="rate">Rate${sortMark('rate')}</th><th class="r" data-sort="amount">Amount${sortMark('amount')}</th>
      <th${dim === 'package' ? ' class="on"' : ''}>Package</th><th${dim === 'mnl' ? ' class="on"' : ''}>MNL</th><th${dim === 'cec' ? ' class="on"' : ''}>Cost element</th></tr></thead>
      <tbody>${html || `<tr><td colspan="12" class="muted">${ui.lines.length ? 'No rows match this filter or period.' : 'No rows.'}</td></tr>`}</tbody></table>`;
    const allBox = $('wp-all'); if (allBox) allBox.indeterminate = selVis > 0 && selVis < visIds.length;
    host.querySelectorAll('input[data-grp]').forEach((b) => { b.indeterminate = b.dataset.state === 'some'; });
    renderBar(); foldButtons();
  }
  // PO count on every group that is not itself a PO (or inside one)
  function poN(g, level, list) {
    if (g === 'po' || (level === 2 && eff().g1 === 'po')) return '';
    const n = new Set(list.flatMap((r) => [...r.pos.keys()])).size; return ` · <b class="pon">${n} PO${n === 1 ? '' : 's'}</b>`;
  }
  function groupRow(level, g, k, list, id) {
    const dim = ui.dim; const n = list.length, open = list.filter((r) => !codeOf(r, dim)).length;
    const amt = list.reduce((a, r) => a + r.amount, 0); const share = ui.total ? amt / ui.total * 100 : 0;
    const codedAmt = list.filter((r) => codeOf(r, dim)).reduce((a, r) => a + r.amount, 0);
    const pct = n ? (n - open) / n * 100 : 0; const sel = list.filter((r) => ui.selected.has(r.id)).length;
    const stateS = sel === 0 ? 'none' : sel === n ? 'all' : 'some'; const cid = level + id;
    return `<tr class="wpg l${level}"><td class="ck"><input type="checkbox" data-grp="${esc(cid)}" data-state="${stateS}" ${stateS === 'all' ? 'checked' : ''} aria-label="Select group"></td>
      <td colspan="4"><button class="wpc" data-toggle="${esc(cid)}" aria-expanded="${!ui.collapsed.has(cid)}">${ui.collapsed.has(cid) ? '▸' : '▾'}</button><b><bdi>${esc(groupLabel(g, k, list[0]))}</bdi></b>
      <span class="muted"> · ${n} items${poN(g, level, list)}${open ? ` · <span class="warnx">${open} unallocated</span>` : ''} · ${share.toFixed(1)}% of total</span></td>
      <td></td><td class="r num">${fmtN(list.reduce((a, r) => a + r.lines, 0))}</td><td></td><td></td><td class="r num">${fmtN(amt)}</td>
      <td colspan="3"><span class="meter ${open ? 'part' : 'full'}" title="${DIMS[dim]}: ${n - open} of ${n} rows coded, ${amt ? (codedAmt / amt * 100).toFixed(0) : 0}% of this group's amount"><i style="width:${pct.toFixed(0)}%"></i></span> <span class="muted">${pct.toFixed(0)}% coded</span></td></tr>`;
  }
  const fmtQ = (q) => (q ? fmtN(q, Math.abs(q % 1) > 1e-9 ? 2 : 0) : '');
  const fmtR = (r) => (r == null ? '' : fmtN(r, 2));
  function leafRow(r) {
    const poCell = ui.view === 'svc'
      ? `<button class="wpd" data-drill="${esc(r.id)}" aria-expanded="${ui.drill.has(r.id)}" title="Show the POs for this service">${r.npo} ${ui.drill.has(r.id) ? '▾' : '▸'}</button>`
      : (r.others ? `<span class="wpo2" title="Coding this row also codes it on ${r.others} other PO${r.others === 1 ? '' : 's'}">+${r.others} PO${r.others === 1 ? '' : 's'}</span>` : '');
    return `<tr class="wpl${ui.selected.has(r.id) ? ' sel' : ''}" data-id="${esc(r.id)}"><td class="ck"><input type="checkbox" data-row="${esc(r.id)}" ${ui.selected.has(r.id) ? 'checked' : ''} aria-label="Select ${esc(r.svc)}"></td>
      <td class="num">${esc(r.svc)}</td><td class="ar">${esc(r.text)}</td><td class="muted">${esc(r.unit)}</td><td class="r">${poCell}</td>
      <td class="r num">${fmtN(r.lines)}</td><td class="r num">${fmtQ(r.qty)}</td><td class="r num">${fmtR(r.rate)}</td><td class="r num">${fmtN(r.amount)}</td>
      <td class="bd">${badge(r, 'package')}</td><td class="bd">${badge(r, 'mnl')}</td><td class="bd">${badge(r, 'cec')}</td></tr>`;
  }
  // read-only breakdown of one service across its POs
  function drillRows(r) {
    return [...r.pos.values()].sort((a, b) => b.amount - a.amount).map((p) => {
      const rate = p.qty ? p.amount / p.qty : null, off = rate != null && r.rate != null && Math.abs(rate - r.rate) > Math.max(0.01, Math.abs(r.rate) * 0.01);
      return `<tr class="wpsub"><td></td><td colspan="4"><span class="muted">PO</span> <b class="num">${esc(p.po)}</b> · <bdi>${esc(p.sup)}</bdi></td>
        <td class="r num">${fmtN(p.lines)}</td><td class="r num">${fmtQ(p.qty)}</td><td class="r num${off ? ' rdiff' : ''}"${off ? ' title="Rate differs from the service average"' : ''}>${fmtR(rate)}</td><td class="r num">${fmtN(p.amount)}</td><td colspan="3"></td></tr>`;
    }).join('');
  }
  function renderBar() {
    const bar = $('wp-bar'); const n = ui.selected.size; const dim = ui.dim;
    const selRows = [...ui.selected].map((id) => ui.byId.get(id)).filter(Boolean);
    const common = selRows.length && selRows.every((r) => codeOf(r, dim) === codeOf(selRows[0], dim)) ? codeOf(selRows[0], dim) : null;
    const sugN = selRows.filter((r) => !codeOf(r, dim) && (ui.sugg.get(r.key) || {})[dim]).length;
    const dims = Object.entries(DIMS).map(([d, l]) => `<button class="seg${d === dim ? ' on' : ''}" data-dim="${d}" aria-pressed="${d === dim}">${l}</button>`).join('');
    let right;
    if (!n) right = `<span class="muted">Tick rows or whole groups, then pick a ${DIMS[dim]} here. Suggestions (dashed) need Accept.</span>`;
    else {
      const picks = cat()[dim].map((c) => `<button class="pick${common === c.code ? ' on' : ''}" style="--c:#${c.color}" data-pick="${esc(c.code)}" title="${esc(c.code + ' – ' + c.label)}">${c.icon ? `<i>${c.icon}</i>` : ''}${esc(c.code)}</button>`).join('');
      const add = dim === 'cec' ? `<span class="newce"><input id="wp-newcode" placeholder="New code" aria-label="New cost element code" maxlength="20"><input id="wp-newlabel" placeholder="Name (optional)" aria-label="New cost element name" maxlength="60"><button id="wp-newadd">+ Add &amp; apply</button></span>` : '';
      right = `<b>${n} selected</b>${sugN ? `<button class="acc" id="wp-accept">Accept ${sugN} suggestion${sugN === 1 ? '' : 's'}</button>` : ''}<span class="picks">${picks || '<span class="muted">No cost elements yet for this project – add one:</span>'}${add}</span><button id="wp-clear">Clear selection</button>`;
    }
    bar.innerHTML = `<span class="segs" role="group" aria-label="Coding dimension">${dims}</span><button class="wpedit" id="wp-editlist" title="Add, rename, re-order or delete ${DIMS[dim]} codes">✎ Edit ${DIMS[dim]} list</button>${right}`;
  }

  // ---------- period bar
  function renderPeriod() {
    const host = $('wp-pills'); if (!host) return;
    host.innerHTML = ui.periods.map(([k, v]) => `<button class="pp${ui.period.has(k) ? ' on' : ''}${k === '000000' || k === '999999' ? ' ex' : ''}" data-period="${k}" aria-pressed="${ui.period.has(k)}" title="${esc(blabel(k))}: ${fmtN(v)}">${esc(blabel(k))}</button>`).join('');
    const ds = ui.lines.map((l) => l.d).filter(Boolean); const iso = (d) => (d ? `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6, 8)}` : '');
    if (ds.length) { const lo = iso(Math.min(...ds)), hi = iso(Math.max(...ds)); for (const id of ['wp-from', 'wp-to']) { $(id).min = lo; $(id).max = hi; } }
    const filtered = ui.period.size || ui.from || ui.to;
    $('wp-pstate').innerHTML = filtered ? `<b>${fmtN(ui.total)}</b> of ${fmtN(ui.allTotal)} · ${ui.allTotal ? (ui.total / ui.allTotal * 100).toFixed(1) : '0'}%` : 'All data shown';
    $('wp-pclear').hidden = !filtered;
  }
  const setPeriod = () => { ui.selected.clear(); regroup(); };

  // ---------- actions
  function apply(value) {
    const keys = [...new Set([...ui.selected].map((id) => ui.byId.get(id)).filter(Boolean).map((r) => r.key))];
    const n = E.assign(state.wp, state.plant, keys, ui.dim, value);
    ui.selected.clear(); afterEdit(`${DIMS[ui.dim]} ${value || 'removed'} on ${keys.length} service${keys.length === 1 ? '' : 's'}${n !== keys.length ? ` (${keys.length - n} already had it)` : ''}.`);
  }
  function acceptSuggestions() {
    const byCode = new Map();
    for (const id of ui.selected) { const r = ui.byId.get(id); if (!r || codeOf(r, ui.dim)) continue; const s = (ui.sugg.get(r.key) || {})[ui.dim]; if (!s) continue;
      if (!byCode.has(s[0])) byCode.set(s[0], new Set()); byCode.get(s[0]).add(r.key); }
    let n = 0; for (const [code, keys] of byCode) n += E.assign(state.wp, state.plant, [...keys], ui.dim, code);
    ui.selected.clear(); afterEdit(`Accepted ${n} suggested ${DIMS[ui.dim]} code${n === 1 ? '' : 's'}.`);
  }
  function afterEdit(msg) {
    state.wpDirty = true; ui.sugg = E.suggest(state.analysis, state.wp); render();
    $('wp-status').textContent = msg + (state.toolDirty ? ' Click 💾 Save tool to keep the lists in this tool; download the master to keep your coding.' : ' Download the updated master to keep your coding.'); setCodingPill();
  }
  function listsChanged() { state.wp.version = E.listStamp(); state.toolDirty = true; const b = $('btn-savetool'); if (b) b.classList.add('dirty'); }
  function onClick(e) {
    const t = e.target;
    if (t.id === 'wp-editlist') { openEditor(ui.dim); return; }
    if (t.dataset.dim && t.classList.contains('seg')) { ui.dim = t.dataset.dim; render(); return; }
    if (t.dataset.pick !== undefined) { apply(t.dataset.pick); return; }
    if (t.dataset.view) { if (t.dataset.view !== ui.view) { ui.view = t.dataset.view; ui.selected.clear(); ui.drill.clear(); showView(); regroup(); } return; }
    const dr = t.closest('[data-drill]'); if (dr) { const k = dr.dataset.drill; ui.drill.has(k) ? ui.drill.delete(k) : ui.drill.add(k); render(); return; }
    if (t.dataset.period) { const k = t.dataset.period; ui.period.has(k) ? ui.period.delete(k) : ui.period.add(k); setPeriod(); return; }
    if (t.id === 'wp-pclear') { ui.period.clear(); ui.from = ui.to = 0; $('wp-from').value = $('wp-to').value = ''; setPeriod(); return; }
    if (t.id === 'wp-accept') { acceptSuggestions(); return; }
    if (t.id === 'wp-clear') { ui.selected.clear(); render(); return; }
    if (t.id === 'wp-newadd') {
      const code = $('wp-newcode').value.trim(), label = $('wp-newlabel').value.trim();
      if (!code) { $('wp-status').textContent = 'Type a code for the new cost element first.'; return; }
      if (!state.wp.costElements.has(state.plant)) state.wp.costElements.set(state.plant, new Map());
      state.wp.costElements.get(state.plant).set(code, label); listsChanged(); apply(code); return; }
    if (t.dataset.undo) { const r = ui.byId.get(t.dataset.undo); E.assign(state.wp, state.plant, [r.key], t.dataset.dim, ''); afterEdit(`Removed ${DIMS[t.dataset.dim]} from ${r.svc}.`); return; }
    const tog = t.closest('[data-toggle]'); if (tog) { const k = tog.dataset.toggle; ui.collapsed.has(k) ? ui.collapsed.delete(k) : ui.collapsed.add(k); render(); return; }
    const th = t.closest('th[data-sort]'); if (th) { const c = th.dataset.sort; ui.sort = { col: c, dir: ui.sort.col === c ? -ui.sort.dir : (c === 'amount' || c === 'lines' ? -1 : 1) }; render(); return; }
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.row) { t.checked ? ui.selected.add(t.dataset.row) : ui.selected.delete(t.dataset.row); render(); return; }
    if (t.id === 'wp-all') { const ids = visibleRows().map((r) => r.id); if (t.checked) ids.forEach((i) => ui.selected.add(i)); else ids.forEach((i) => ui.selected.delete(i)); render(); return; }
    if (t.dataset.grp) {
      const lvl = t.dataset.grp[0], key = t.dataset.grp.slice(1); const { g1, g2 } = eff();
      const ids = visibleRows().filter((r) => lvl === '1' ? groupKey(r, g1) === key : (groupKey(r, g1) + '\u0002' + groupKey(r, g2)) === key).map((r) => r.id);
      const selectAll = t.dataset.state !== 'all'; ids.forEach((i) => (selectAll ? ui.selected.add(i) : ui.selected.delete(i))); render(); return; }
  }
  // Pivot-style fold levels: 0 = everything open, 1 = rows hidden under the 2nd-level groups,
  // 2 = only the 1st-level groups. Without a 2nd level, level 1 is skipped.
  const level2 = () => eff().g2;
  const GNAME = { svcgroup: 'Service group', po: 'PO', supplier: 'Supplier', month: 'Month', package: 'Package', mnl: 'MNL', cec: 'Cost element' };
  function applyFold() {
    const { g1, g2 } = eff(); ui.collapsed = new Set();
    if (ui.fold === 0) return;
    for (const r of visibleRows()) { const k1 = groupKey(r, g1);
      if (ui.fold === 2 || g2 === 'none') ui.collapsed.add('1' + k1);
      else ui.collapsed.add('2' + k1 + '\u0002' + groupKey(r, g2)); }
  }
  function stepFold(dir) {
    const two = level2() !== 'none';
    if (!two && ui.fold === 1) ui.fold = dir > 0 ? 2 : 0;
    ui.fold = Math.max(0, Math.min(2, ui.fold + dir));
    if (!two && ui.fold === 1) ui.fold = dir > 0 ? 2 : 0;
    aggregate(); applyFold(); render();
  }
  function foldButtons() {
    const two = level2() !== 'none', c = $('wp-collapse'), x = $('wp-expand');
    if (!c || !x) return;
    const n1 = GNAME[eff().g1] || '', n2 = two ? GNAME[eff().g2] : '';
    c.disabled = ui.fold === 2; x.disabled = ui.fold === 0 && ui.collapsed.size === 0;
    c.textContent = ui.fold === 0 && two ? 'Collapse to ' + n2 : 'Collapse to ' + n1;
    x.textContent = ui.fold === 2 && two ? 'Expand to ' + n2 : 'Expand all';
  }
  function showView() {
    document.querySelectorAll('#view-coding [data-view]').forEach((b) => { const on = b.dataset.view === ui.view; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $('wp-g1l').hidden = $('wp-g2l').hidden = ui.view !== 'svc';
  }
  const regroup = () => { aggregate(); applyFold(); render(); };
  // ---------- list editor: add / rename (name or code) / re-order / delete the codes of one dimension.
  // Works on a draft; Save applies it to the catalogue and to every service coded with it (a new code moves its services,
  // a deleted code leaves them unallocated on that dimension).
  const normCode = (dim, c) => { const t = String(c || '').trim(); const m = dim === 'package' && /^DIV\s*(\d{1,4})$/i.exec(t); return m ? 'DIV ' + m[1].padStart(m[1].length > 2 ? 4 : 2, '0') : t; };
  const used = (dim, code) => { let n = 0; const pre = (state.plant || '') + '\u0001';
    for (const [k, v] of state.wp.mapping) if (v[dim] === code && (dim !== 'cec' || k.startsWith(pre))) n++; return n; };
  let ed = null;
  function openEditor(dim) {
    const wp = state.wp, pr = state.plant || '';
    if (dim === 'cec' && !pr) { $('wp-status').textContent = 'Build a report first – cost elements belong to a project.'; return; }
    const src = dim === 'package' ? wp.packages : dim === 'mnl' ? wp.mnl : [...(wp.costElements.get(pr) || new Map())].map(([code, label]) => ({ code, label }));
    ed = { dim, rows: src.map((x) => ({ orig: x.code, code: x.code, label: x.label || '', group: x.group || '', icon: x.icon || '', color: x.color || '', system: !!x.system, del: false, n: used(dim, x.code) })) };
    let dlg = $('wp-editor');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'wp-editor'; dlg.className = 'wped'; document.body.appendChild(dlg);
      dlg.addEventListener('click', edClick); dlg.addEventListener('input', edInput); dlg.addEventListener('cancel', () => { ed = null; }); }
    edRender(); dlg.showModal();
  }
  function edRender() {
    const dlg = $('wp-editor'), d = ed.dim, isP = d === 'package';
    const groups = [...new Set(state.wp.packages.map((p) => p.group).concat(ed.rows.map((r) => r.group)).filter(Boolean))];
    const head = `<tr>${isP ? '<th></th>' : ''}<th>Code</th><th>Name</th>${isP ? '<th>Group</th><th>Icon</th>' : ''}<th class="r">Services coded</th><th></th><th></th></tr>`;
    const body = ed.rows.map((r, i) => `<tr class="${r.del ? 'del' : ''}">${isP ? `<td class="mv"><button data-up="${i}" title="Move up" ${i ? '' : 'disabled'}>▲</button><button data-dn="${i}" title="Move down" ${i < ed.rows.length - 1 ? '' : 'disabled'}>▼</button></td>` : ''}
      <td><input data-i="${i}" data-f="code" value="${esc(r.code)}" maxlength="20" ${r.del ? 'disabled' : ''} aria-label="Code"></td>
      <td><input data-i="${i}" data-f="label" value="${esc(r.label)}" maxlength="60" ${r.del ? 'disabled' : ''} aria-label="Name"></td>
      ${isP ? `<td><input data-i="${i}" data-f="group" value="${esc(r.group)}" list="wped-groups" maxlength="20" ${r.del ? 'disabled' : ''} aria-label="Group"></td><td><input class="ic" data-i="${i}" data-f="icon" value="${esc(r.icon)}" maxlength="4" ${r.del ? 'disabled' : ''} aria-label="Icon"></td>` : ''}
      <td class="r num">${r.orig ? r.n : 'new'}</td>
      <td><button class="ins" data-ins="${i}" title="Insert a new code below ${esc(r.code || 'this row')}">＋ Insert below</button></td>
      <td>${r.del ? `<button data-undel="${i}">Undo</button>` : `<button class="x" data-del="${i}" title="Delete">Delete</button>`}</td></tr>`).join('');
    dlg.innerHTML = `<form method="dialog" onsubmit="return false"><h3>Edit ${esc(DIMS[d])} list${d === 'cec' ? ' · ' + esc(state.plant || '') : ''}</h3>
      <p class="muted">Rename freely – a new code moves every service already coded with it. Deleting leaves those services unallocated on ${esc(DIMS[d])}.${isP ? ' Order here = order on the Dashboard and Service Monthly.' : ''}</p>
      <div class="wped-scroll"><table class="wped-t"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      <datalist id="wped-groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
      <div class="wped-add"><button id="wped-add">+ Add ${esc(DIMS[d])}</button><span class="wped-msg" id="wped-msg" role="alert"></span></div>
      <div class="wped-act"><button id="wped-cancel">Cancel</button><button class="primary" id="wped-save">Save changes</button></div></form>`;
  }
  function edInput(e) { const t = e.target; if (t.dataset.i != null) ed.rows[+t.dataset.i][t.dataset.f] = t.value; }
  function edClick(e) {
    const t = e.target.closest('button'); if (!t) return; e.preventDefault();
    const r = ed.rows;
    if (t.dataset.up != null) { const i = +t.dataset.up; [r[i - 1], r[i]] = [r[i], r[i - 1]]; return edRender(); }
    if (t.dataset.dn != null) { const i = +t.dataset.dn; [r[i + 1], r[i]] = [r[i], r[i + 1]]; return edRender(); }
    if (t.dataset.del != null) { const x = r[+t.dataset.del]; if (!x.orig) r.splice(+t.dataset.del, 1); else x.del = true; return edRender(); }
    if (t.dataset.undel != null) { r[+t.dataset.undel].del = false; return edRender(); }
    const blank = (like) => ({ orig: null, code: '', label: '', group: ed.dim === 'package' ? ((like && like.group) || 'General') : '', icon: '', color: '', system: false, del: false, n: 0 });
    const focusRow = (i) => { const ins = $('wp-editor').querySelectorAll('input[data-f="code"]'); ins[i].focus(); ins[i].closest('tr').scrollIntoView({ block: 'nearest' }); };
    if (t.dataset.ins != null) { const i = +t.dataset.ins; r.splice(i + 1, 0, blank(r[i])); edRender(); focusRow(i + 1); return; }
    if (t.id === 'wped-add') { r.push(blank(r[r.length - 1])); edRender(); focusRow(r.length - 1); return; }
    if (t.id === 'wped-cancel') { $('wp-editor').close(); ed = null; return; }
    if (t.id === 'wped-save') edSave();
  }
  function edSave() {
    const d = ed.dim, wp = state.wp, pr = state.plant || '', msg = (m) => { $('wped-msg').textContent = m; };
    const keep = ed.rows.filter((r) => !r.del).map((r) => ({ ...r, code: normCode(d, r.code), label: String(r.label).trim(), group: String(r.group).trim() }));
    const bad = keep.find((r) => !r.code); if (bad) return msg('Every row needs a code (or delete the empty row).');
    const seen = new Set(); for (const r of keep) { const k = r.code.toUpperCase(); if (seen.has(k)) return msg(`The code ${r.code} is used twice.`); seen.add(k); }
    const ren = new Map(), gone = new Set();
    for (const r of ed.rows) if (r.orig) { if (r.del) gone.add(r.orig); else { const nc = normCode(d, r.code); if (nc !== r.orig) ren.set(r.orig, nc); } }
    // catalogue
    if (d === 'package') wp.packages = keep.map((r, i) => ({ code: r.code, label: r.label || r.code, group: r.group || 'General', icon: r.icon.trim(),
      color: E.GROUP_COLOR[r.group] || (r.orig && r.color) || '6B7280', sort: i + 1, system: r.system }));
    else if (d === 'mnl') wp.mnl = keep.map((r) => ({ code: r.code, label: r.label || r.code, system: r.system }));
    else wp.costElements.set(pr, new Map(keep.map((r) => [r.code, r.label])));
    // codings: renamed codes follow, deleted codes are cleared (cost elements: this project only)
    let moved = 0, cleared = 0; const pre = pr + '\u0001';
    for (const [k, v] of [...wp.mapping]) { if (d === 'cec' && !k.startsWith(pre)) continue; const c = v[d]; if (!c) continue;
      if (ren.has(c)) { v[d] = ren.get(c); v.updated = new Date(); moved++; }
      else if (gone.has(c)) { v[d] = ''; v.updated = new Date(); cleared++; if (!(v.package || v.mnl || v.cec || v.unit)) wp.mapping.delete(k); } }
    $('wp-editor').close(); ed = null; listsChanged();
    const added = keep.filter((r) => !r.orig).length;
    afterEdit(`${DIMS[d]} list saved: ${keep.length} codes` + (added ? `, ${added} added` : '') + (ren.size ? `, ${ren.size} renamed (${moved} codings moved)` : '') + (gone.size ? `, ${gone.size} deleted (${cleared} codings now unallocated)` : '') + '.');
  }
  function mount() {
    const v = $('view-coding');
    v.addEventListener('click', onClick); v.addEventListener('change', onChange); showView();
    $('wp-filter').addEventListener('input', (e) => { ui.filter = e.target.value.trim().toLowerCase(); regroup(); });
    $('wp-open').addEventListener('change', (e) => { ui.onlyOpen = e.target.checked; regroup(); });
    $('wp-g1').addEventListener('change', (e) => { ui.g1 = e.target.value; regroup(); });
    $('wp-g2').addEventListener('change', (e) => { ui.g2 = e.target.value; regroup(); });
    $('wp-from').addEventListener('change', (e) => { ui.from = dkey(e.target.value); setPeriod(); });
    $('wp-to').addEventListener('change', (e) => { ui.to = dkey(e.target.value); setPeriod(); });
    $('wp-expand').addEventListener('click', () => stepFold(-1));
    $('wp-collapse').addEventListener('click', () => stepFold(1));
    // the header row sits under the selection bar, whatever height the bar wraps to
    try { new ResizeObserver(() => { v.style.setProperty('--sel-bar-h', $('wp-bar').offsetHeight + 'px'); }).observe($('wp-bar')); } catch (e) {}
  }
  return { render, mount, reset() { ui.drill.clear(); ui.lines = null; ui.rows = []; ui.sig = null; ui.selected.clear(); ui.collapsed.clear(); ui.fold = 0; } };
})();
