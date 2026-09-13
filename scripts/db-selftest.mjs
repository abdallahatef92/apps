/**
 * Headless check of the warehouse layer: schema, calendar, query library, and
 * every system query against a synthetic project.
 *
 * Uses Node's built-in SQLite rather than better-sqlite3, because the app's copy
 * of better-sqlite3 is compiled against Electron's ABI and will not load in plain
 * Node. Run: npm run db:check
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ci-selftest-'));
const db = new DatabaseSync(join(dir, 'test.db'));
db.exec('PRAGMA foreign_keys = ON');

db.exec(readFileSync('src/main/db/migrations/001_core.sql', 'utf8'));
db.exec(readFileSync('src/main/db/migrations/002_seed.sql', 'utf8'));

// Minimal calendar
const pad = (n) => String(n).padStart(2, '0');
const insP = db.prepare(`INSERT INTO dim_period
  (period_key, year_no, month_no, quarter_no, label, start_date, end_date, period_index)
  VALUES (?,?,?,?,?,?,?,?)`);
for (let m = 1; m <= 12; m++) {
  insP.run(`2026-${pad(m)}`, 2026, m, Math.ceil(m / 3), `M${m} 2026`,
    `2026-${pad(m)}-01`, `2026-${pad(m)}-28`, m);
}

// --- synthetic data ---------------------------------------------------------
const projectKey = Number(db.prepare('INSERT INTO dim_project (project_code, project_name) VALUES (?,?)')
  .run('P-100', 'Test Plant').lastInsertRowid);

const wbs = ['CIV-01', 'MEC-01', 'ELE-01'].map((code, i) => Number(
  db.prepare('INSERT INTO dim_wbs (project_key, wbs_code, wbs_name, wbs_path, discipline) VALUES (?,?,?,?,?)')
    .run(projectKey, code, `${code} works`, `/${code}/`, code.slice(0, 3)).lastInsertRowid) + 0 * i);

const ce = Number(db.prepare('INSERT INTO dim_cost_element (cost_element_code, cost_element_name, cost_type) VALUES (?,?,?)')
  .run('600100', 'Subcontract works', 'SUBCONTRACT').lastInsertRowid);

function batch(rd, module, dataDate, period) {
  return Number(db.prepare(`INSERT INTO import_batch
    (report_definition_id, module, data_date, period_key, project_key, file_name, status, row_count_file, row_count_posted)
    VALUES (?,?,?,?,?,?, 'POSTED', 10, 10)`)
    .run(rd, module, dataDate, period, projectKey, `${module}.xlsx`).lastInsertRowid);
}

const scenarioBudget = Number(db.prepare(`INSERT INTO dim_scenario
  (project_key, scenario_code, scenario_name, scenario_type, version_no, data_date, is_current, is_baseline)
  VALUES (?,?,?,?,1,?,1,1)`).run(projectKey, 'BUDGET-2026-01-01', 'Budget v1', 'BUDGET', '2026-01-01').lastInsertRowid);
const scenarioFc = Number(db.prepare(`INSERT INTO dim_scenario
  (project_key, scenario_code, scenario_name, scenario_type, version_no, data_date, is_current)
  VALUES (?,?,?,?,1,?,1)`).run(projectKey, 'FORECAST-2026-03-31', 'Forecast v1', 'FORECAST', '2026-03-31').lastInsertRowid);

const bBud = batch(3, 'BUDGET', '2026-01-01', null);
const bAct = batch(1, 'ACTUAL', '2026-03-31', '2026-03');
const bFc = batch(4, 'FORECAST', '2026-03-31', null);

const insBud = db.prepare(`INSERT INTO fact_budget
  (import_batch_id, scenario_key, project_key, wbs_key, cost_element_key, period_key, budget_amount)
  VALUES (?,?,?,?,?,?,?)`);
const insAct = db.prepare(`INSERT INTO fact_actual
  (import_batch_id, project_key, wbs_key, cost_element_key, period_key, amount, quantity, document_no)
  VALUES (?,?,?,?,?,?,?,?)`);
const insFc = db.prepare(`INSERT INTO fact_forecast
  (import_batch_id, scenario_key, project_key, wbs_key, cost_element_key, period_key, forecast_amount)
  VALUES (?,?,?,?,?,?,?)`);

const budgets = [1_000_000, 600_000, 400_000];
wbs.forEach((w, i) => {
  for (let m = 1; m <= 6; m++) insBud.run(bBud, scenarioBudget, projectKey, w, ce, `2026-${pad(m)}`, budgets[i] / 6);
  for (let m = 1; m <= 3; m++) insAct.run(bAct, projectKey, w, ce, `2026-${pad(m)}`, (budgets[i] / 6) * (i === 0 ? 1.4 : 0.8), 10, `DOC${m}`);
  for (let m = 4; m <= 6; m++) insFc.run(bFc, scenarioFc, projectKey, w, ce, `2026-${pad(m)}`, budgets[i] / 6);
});

// --- run every system query -------------------------------------------------
const queries = JSON.parse(execFileSync('node', ['scripts/dump-queries.mjs'], { encoding: 'utf8' }));

let failures = 0;
for (const q of queries) {
  try {
    if (/^\s*(insert|update|delete|drop|alter|create|pragma)\b/i.test(q.sql.trim())) {
      throw new Error('statement is not read-only');
    }
    const stmt = db.prepare(q.sql.trim());
    const names = [...new Set([...q.sql.matchAll(/(?<![:\w]):([a-zA-Z_]\w*)/g)].map((m) => m[1]))];
    const binding = {};
    for (const n of names) binding[n] = n === 'project_key' ? projectKey : n === 'top_n' ? 20 : null;
    const rows = stmt.all(binding);
    console.log(`  ok  ${q.code.padEnd(22)} ${String(rows.length).padStart(4)} rows`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${q.code}: ${err.message}`);
  }
}

// --- assertions on the numbers ---------------------------------------------
function assert(label, actual, expected) {
  const ok = Math.abs(actual - expected) < 0.01;
  if (!ok) { failures++; console.error(`  FAIL ${label}: got ${actual}, expected ${expected}`); }
  else console.log(`  ok  ${label} = ${actual}`);
}

const totals = db.prepare(`SELECT
    (SELECT SUM(budget_amount)   FROM v_budget   WHERE project_key = ?) AS budget,
    (SELECT SUM(amount)          FROM v_actual   WHERE project_key = ?) AS actual,
    (SELECT SUM(forecast_amount) FROM v_forecast WHERE project_key = ?) AS forecast`)
  .get(projectKey, projectKey, projectKey);

assert('total budget', totals.budget, 2_000_000);
assert('total actual', totals.actual, (1_000_000 / 6) * 1.4 * 3 + (600_000 / 6) * 0.8 * 3 + (400_000 / 6) * 0.8 * 3);
assert('total forecast', totals.forecast, 1_000_000);

// Superseding: a newer posted batch must hide the older one from the views.
const bAct2 = batch(1, 'ACTUAL', '2026-04-30', '2026-03');
insAct.run(bAct2, projectKey, wbs[0], ce, '2026-03', 999, 1, 'NEW');
db.prepare(`UPDATE import_batch SET status='SUPERSEDED', superseded_by=? WHERE import_batch_id=?`).run(bAct2, bAct);
const after = db.prepare('SELECT SUM(amount) AS a FROM v_actual WHERE project_key = ?').get(projectKey);
assert('superseded batch excluded', after.a, 999);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
