// Lists and coding dimensions: DIV is automatic from the service code (override allowed), Package is the team's own list,
// master rows added in Excel survive newer tool lists, codes deleted in the tool stay deleted, old masters / reports migrate
const E = require('../engine.js'), ExcelJS = require('exceljs'), X = require('xlsx'), assert = require('assert');
const sheets = (buf) => { const w = X.read(buf); const o = {}; for (const n of w.SheetNames) o[n] = X.utils.sheet_to_json(w.Sheets[n], { header: 1, raw: true, defval: '' }); return o; };
(async () => {
  // 1. automatic DIV
  const cat = E.defaultMaster().packages;
  for (const [svc, want] of [['S0303-M3', 'DIV 03'], ['S0401', 'DIV 04'], ['S0102', 'INDIRECT'], ['S3401', 'INDIRECT'], ['S2501', 'DIV 27'], ['L0101', 'INDIRECT'], ['P0123', 'INDIRECT'], ['S1501', ''], ['X1', '']])
    assert.strictEqual(E.autoDiv(svc, cat), want, 'auto DIV ' + svc);
  assert.strictEqual(E.autoDiv('S3301', cat.filter((p) => p.code !== 'DIV 33')), '', 'a division deleted from the list gives no automatic DIV');
  // 2. assign: the automatic DIV is not stored; a different one is an override
  const m1 = E.defaultMaster();
  assert.strictEqual(E.assign(m1, 'TRAZ', ['S0303\u0001a'], 'package', 'DIV 03'), 0, 'picking the automatic DIV stores nothing');
  E.assign(m1, 'TRAZ', ['S0303\u0001a'], 'package', 'DIV 05'); assert.strictEqual(m1.mapping.get(E.mkey('TRAZ', 'S0303', 'a')).package, 'DIV 05', 'override stored');
  // 3. an older master: the division list on 'Packages' (with team codes S03 typed into it), Service Mapping → Package holding DIVs and team names
  const old = { Packages: [['Code', 'Label', 'Group', 'Icon', 'Color', 'Sort', 'System', 'Catalogue v2']].concat(E.defaultMaster().packages.map((p) => [p.code, p.label, p.group, p.icon, '#' + p.color, p.sort, 'yes', ''])).concat([['S03', 'S03', 'General', '', '', 99, '', '']]),
    'Service Mapping': [['Project', 'Service', 'Service text', 'Package', 'MNL', 'Cost Element', 'Unit override', 'Updated'],
      ['TRAZ', 'S0303', 'a', 'DIV 03', 'SUB', '', '', ''], ['TRAZ', 'S0401', 'b', 'S04', '', '', '', ''], ['TRAZ', 'S0303', 'c', 'DIV 05', '', '', '', ''], ['TRAZ', 'S0303', 'd', 'S03', 'MAT', '', '', ''], ['TRAZ', 'S0903', 'e', 'Facade', '', '', '', '']] };
  const mo = E.readMaster(old), get = (svc, t) => mo.mapping.get(E.mkey('TRAZ', svc, t)) || null;
  assert.ok(!mo.packages.some((p) => p.code === 'S03'), 'S03 typed into the old list is gone');
  assert.deepStrictEqual([get('S0303', 'a').package, get('S0303', 'a').mnl], ['', 'SUB'], 'DIV equal to the automatic one is cleared, MNL kept');
  assert.strictEqual(get('S0401', 'b'), null, 'S04 on an S04 service = automatic, nothing left to store');
  assert.strictEqual(get('S0303', 'c').package, 'DIV 05', 'a different DIV stays as an override');
  assert.deepStrictEqual([get('S0303', 'd').package, get('S0303', 'd').wp, get('S0303', 'd').mnl], ['', '', 'MAT'], 'S03 on an S03 service = automatic');
  assert.strictEqual(get('S0903', 'e').wp, 'Facade', 'a non-division code in the old Package column becomes the team package'); assert.ok(mo.wpList.some((x) => x.code === 'Facade'));
  // 4. a new master round trip: DIV sheet, Packages = team list, Service Mapping with DIV + Package
  const nb = sheets(Buffer.from(await E.buildMaster(mo, { ExcelJS })));
  assert.deepStrictEqual(nb['Service Mapping'][0].slice(0, 6), ['Project', 'Service', 'Service text', 'DIV', 'Package', 'MNL']);
  assert.deepStrictEqual(nb['Packages'][0], ['Code', 'Label']); assert.ok(nb['DIV'][0].includes('Catalogue v' + mo.version));
  const mr = E.readMaster(nb); assert.deepStrictEqual([...mr.mapping].map(([k, v]) => [k, v.package, v.wp, v.mnl]), [...mo.mapping].map(([k, v]) => [k, v.package, v.wp, v.mnl]), 'master round trip');
  // 5. tool lists newer than the master: rows added in Excel (DIV 35, team package Raft, MNL SUBX) are kept; DIV 33 deleted in the tool stays deleted
  nb['DIV'][0] = nb['DIV'][0].map((h) => (/^Catalogue v/.test(h) ? 'Catalogue v2' : h));
  nb['DIV'].push(['DIV 35', 'Waterway and Marine', 'Civil', '⚓', '', 99, '', '']); nb['Packages'].push(['Raft', 'Raft foundation']); nb['MNL'].push(['SUBX', 'Sub – extra', '']);
  const lists = E.listsOf(E.defaultMaster()); lists.version = 20261001120000; lists.packages = lists.packages.filter((p) => p.code !== 'DIV 33'); lists.removed = { package: ['DIV 33'], wp: [], mnl: [] };
  lists.packages.push({ code: 'S04', label: 'S04', group: 'General' });            // a saved tool that still has an S04 row
  E.setBase(lists);
  const m = E.readMaster(nb);
  assert.ok(m.packages.some((p) => p.code === 'DIV 35'), 'DIV row added in Excel kept'); assert.ok(m.mnl.some((x) => x.code === 'SUBX'), 'MNL row added in Excel kept');
  assert.ok(m.wpList.some((x) => x.code === 'Raft' && x.label === 'Raft foundation'), 'team package added in Excel kept');
  assert.ok(!m.packages.some((p) => p.code === 'DIV 33'), 'deleted in the tool, not brought back'); assert.ok(!m.packages.some((p) => p.code === 'S04'), 'S04 dropped from saved tool lists');
  // 6. a report's lists and typed codes
  const prev = { divList: [{ code: 'DIV 36', label: 'Marine works', group: 'civil' }, { code: 'DIV 33', label: 'Utilities' }], wpList: [{ code: 'Piles', label: 'Piling' }], mnlList: [{ code: 'MNLX', label: 'x' }],
    coding: new Map([['A\u0001a', { csi: '', wp: 'Columns', mnl: '' }], ['B\u0001b', { csi: 'DIV 33', wp: '', mnl: '' }]]) };
  const r = E.adoptPackages(m, prev);
  assert.deepStrictEqual([r.packages, r.wp, r.mnl, r.skipped], [['DIV 36'], ['Piles', 'Columns'], ['MNLX'], ['DIV 33', 'DIV 33']]);
  assert.strictEqual(m.packages.find((p) => p.code === 'DIV 36').group, 'Civil', 'group spelling normalised');
  // 7. reading a report: new format (DIV + Package) and old format (Package = DIV)
  const rp = E.readPrevious({ 'Service Coding': [['Svc ID', 'Service', 'Service text', 'Unit', 'Unit source', 'DIV', 'Package', 'MNL', 'Cost Element Code'], [1, 'S0303', 'a', '', '', 'DIV 03', 'Raft', 'SUB', ''], [2, 'S0401', 'b', '', '', 'DIV 04', 'S04', '', '']] });
  assert.deepStrictEqual([rp.coding.get('S0303\u0001a').csi, rp.coding.get('S0303\u0001a').wp], ['DIV 03', 'Raft']); assert.deepStrictEqual([rp.coding.get('S0401\u0001b').csi, rp.coding.get('S0401\u0001b').wp], ['DIV 04', ''], 'S04 typed as a package is a DIV');
  const ro = E.readPrevious({ 'Service Coding': [['Svc ID', 'Service', 'Service text', 'Unit', 'Unit source', 'Package', 'MNL', 'Cost Element Code'], [1, 'S0303', 'a', '', '', 'S03', 'SUB', ''], [2, 'S0903', 'e', '', '', 'Facade', '', '']] });
  assert.deepStrictEqual([ro.coding.get('S0303\u0001a').csi, ro.coding.get('S0903\u0001e').wp, ro.coding.get('S0903\u0001e').csi], ['DIV 03', 'Facade', ''], 'old report migrates');
  console.log('lists ok');
})().catch((e) => { console.error(e); process.exit(1); });
