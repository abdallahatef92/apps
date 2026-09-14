# Cost Intelligence

A local-first cost control workbench for project teams: bring actual cost, budget and
forecast in from the reports you already receive, keep them in a star schema on the
machine, analyse them with SQL, and push the answers back out to Excel.

Built as a desktop app — **Electron + React + Vite + TypeScript + SQLite**. No server,
no cloud, no account. The whole warehouse is one `.db` file you can copy, back up or
hand to a colleague.

---

## The idea

Cost control data never arrives as one clean table. Actuals come out of SAP in several
different extracts, the budget lives in a workbook, the forecast in another, and each is
refreshed on its own rhythm. The usual result is a spreadsheet nobody can date.

So the app is built around three rules:

1. **Every number carries its data date.** Nothing enters the warehouse without an
   as-of date, and the dashboard shows, per source, how old the newest load is.
2. **Nothing is overwritten in place.** Re-uploading a refreshed extract supersedes the
   previous one; the old rows stay in the database so any past position can still be
   explained.
3. **Aggregation happens in SQL.** Every figure on screen is the output of a query
   stored in the database, which you can read, edit and re-run. The interface renders
   result sets; it does not compute them.

---

## Running it on your machine

**You need Node.js 22.5 or newer** — `node --version` to check, https://nodejs.org to
install. Nothing else: no database to install, no server to start, no account.

```bash
git clone https://github.com/abdallahatef92/apps.git
cd apps
git checkout claude/wizardly-keller-a77b8z
npm install
npm run dev
```

`npm install` takes a few minutes: it downloads Electron (~100 MB) and rebuilds
better-sqlite3 against Electron's ABI. `npm run dev` opens the app window.

To try it against sample data before loading your own:

```bash
npm run demo:seed -- ./demo.db    # writes a demo warehouse and the source xlsx files
```

then, pointing the app at that file instead of the default:

```bash
COST_DB_PATH="$PWD/demo.db" npm run dev          # macOS / Linux
$env:COST_DB_PATH="$PWD\demo.db"; npm run dev    # Windows PowerShell
```

Otherwise the database is created automatically in your OS user-data directory the
first time the app starts — Settings shows the exact path, and Settings › Back up now
copies it wherever you like.

### Building an installer

```bash
npm run dist
```

electron-builder produces a `.exe` installer on Windows, a `.dmg` on macOS or an
`.AppImage` on Linux, into `release/`. Packaging has not been exercised in this
environment, only the development run and the test suite — so treat the first
`npm run dist` as something to verify rather than assume.

### If `npm install` fails

Almost always this is better-sqlite3 needing to compile because no prebuilt binary
matched your platform.

- **Windows** — install the "Desktop development with C++" workload from the
  [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/),
  then delete `node_modules` and run `npm install` again.
- **macOS** — `xcode-select --install`.
- **Linux** — `sudo apt install build-essential python3`.

`Error: The module ... was compiled against a different Node.js version` from a plain
`node` command is expected, not a fault: the app's copy of better-sqlite3 is built for
Electron. Run such scripts through `node scripts/run-under-electron.mjs <script>`, which
is what the npm scripts already do.

### Checks

```bash
npm run typecheck   # both TypeScript projects
npm test            # schema checks + the full ingest pipeline, no window needed
npm run build       # production bundles
```

---

## The interface

Three surfaces, all reading the same warehouse:

**Dashboard** — the position at a glance: headline figures with a spend sparkline,
the cost S-curve, a treemap of the breakdown structure sized by spend and shaded by
variance, a cost-type × month heatmap, and the freshness board.

**Analysis** — a searchable rail of analyses grouped by subject, each rendering as a
report: KPI strip, chart, and Chart / Table / SQL tabs, with one-click export. The
chart is not guessed — it comes from the visualisation spec stored beside the query.

**Pivot builder** — pick a source, a grouping and a measure; the SQL is generated
against the reporting views, shown in full, and savable into the library as a normal
analysis. Ad-hoc exploration produces the same kind of artefact as a curated report.

## Working flow

**Upload → map → review → post.**

1. **Source & file.** Say which module — actuals, budget, forecast, subcontractor
   service lines or WBS structure — and which source report this file is, then choose
   it.
2. **Sheet & data date.** The parser finds the header row underneath any title block and
   guesses the as-of date from the file's own text or name. You confirm both.
3. **Column mapping.** Columns are matched to canonical fields automatically — SAP's
   usual captions are already known (`WBS Element`, `Val/COArea Crcy`,
   `Name of offsetting account`, …). Correct anything wrong; saving the mapping makes the
   next upload of that report a single click.
4. **Review & post.** Every row is validated into staging first. You see the row
   counts, how many subtotal rows were recognised and excluded, a control total to
   check against the report footer, which dimension members are new, and every
   rejected row with a reason — before anything reaches the fact tables.

Analysis and Query library then read the posted data; both export to a formatted Excel
workbook that carries a lineage sheet naming the query, the parameters and the row count.

---

## What the real SAP extracts taught us

Three things in a genuine CJI3 export will quietly produce wrong numbers, and the
importer handles all three. They are worth knowing about because they are not obvious.

**A CJI3 export interleaves subtotal rows with detail.** In the sample we worked
from, 181 of 6,628 rows were grand totals and per-cost-element subtotals — blank
document number, real amount. Loading them naively inflates cost by roughly three
times. Each source report declares which canonical fields identify a real data row
(`detail_key_fields`); rows leaving them blank are staged as **SKIPPED**, counted on
the review screen, and never posted. The remaining detail then sums to exactly the
grand total printed in the file, which is the check worth making on every import.

**A CJI3 export contains revenue, not just cost.** Income posts to 4xxxxxxx accounts
as negative amounts against the same WBS. In the sample, summing the file gives
102.5M — but that is cost *net of* 83.1M of billing. Actual cost is 185.6M. Cost
elements are classified on import, `v_actual` holds cost alone, `v_revenue` holds
income sign-flipped to positive, and `v_posting` holds both. The account pattern is a
setting (Settings › Cost classification), because charts of accounts differ.

**A subcontractor report is a sub-ledger, not extra cost.** It is the service-line
detail behind purchase orders already posted in CJI3, so adding it to actuals
double-counts. It lands in `fact_service_line`, joined to `fact_actual` by purchase
order. The *PO reconciliation* analysis compares the two: on the sample, 45 of 46
purchase orders agree to within 1 EGP, and the 46th correctly shows as having no
service detail loaded yet.

These reports are also rarely loaded whole. An extract gets split by month, or re-run
over a wider period, and the parts overlap. Replacing a whole batch cannot express that:
it either loses the months the new file did not cover, or duplicates the ones it did.
So identity lives on the line rather than the file — `document number + posting row +
fiscal year` for a CO line item, `PO + invoice + item + line` for a service line, both
verified unique across the real extracts. Import upserts on it. If that key turns out to
repeat within a file, it is not identifying anything, so it is refused rather than used
to silently drop rows.

A fourth, smaller trap: in an SAP project structure export the **"Title" column holds
the WBS code and "Description" holds its name**, and the root repeats at level 00 and
01. The WBS master importer expects this, and rebuilds parent links, levels, the
materialised path and leaf flags from the level column and row order.

---

## Data model

A star schema, deliberately conventional.

**Facts** — `fact_actual` (one row per SAP posting line, cost and revenue alike),
`fact_budget` and `fact_forecast` (one row per WBS / cost element / scenario /
period), and `fact_service_line` (subcontractor detail beneath a PO, deliberately
outside actuals).

**Dimensions** — `dim_project`, `dim_wbs` (self-referencing hierarchy with a
materialised path, so rollups are a single indexed `LIKE`), `dim_cost_element` (which
carries `posting_nature`, the cost-or-revenue flag), `dim_vendor`, `dim_period`,
`dim_date`, `dim_currency`, and `dim_scenario` for budget and forecast versions.

**Lineage** — `source_system` → `report_definition` → `import_batch`. Every fact row
points at the batch that created it, and every batch records its data date, file name,
sha256, control total and status. The reporting views read only `POSTED` batches, which
is what makes superseding safe.

**Staging** — `stg_row` holds the raw and mapped form of every row read, so a rejection
can always be traced back to the cell it came from. `column_mapping` stores the per-report
profile; `value_mapping` handles source values that need translating to a dimension member.

**Views** — `v_actual` (cost), `v_revenue` (income, positive), `v_posting` (both),
`v_budget`, `v_forecast`, `v_service_line`, `v_data_freshness`. Reports read views,
never fact tables, which is what makes superseding and the cost/revenue split hold.

**Queries** — `query_library` holds the SQL. Queries shipped with the app are marked
`is_system` and refreshed on every start; anything you write is yours and never touched.
The runner rejects any statement that is not read-only.

Schema: [`src/main/db/migrations/001_core.sql`](src/main/db/migrations/001_core.sql).
Query library: [`src/main/db/systemQueries.ts`](src/main/db/systemQueries.ts).

---

## What ships in the query library

*Cost* — actuals by WBS, by cost type, by vendor, by document type, monthly trend,
line-item detail, and the WBS tree with actuals rolled up through the hierarchy.

*Comparison* — budget vs actual by WBS and by cost element, EAC vs budget with VAC,
S-curve, top overruns, portfolio summary, cost vs revenue with running margin.

*Subcontract* — PO reconciliation (actuals against service lines), work by supplier,
work by category, service-line detail, and coverage of actuals by loaded detail.

*Reconciliation* — the unified cost register: every cost line once, merging
direct-cost CJI3 postings (no purchase order) with subcontractor service-line
detail for every PO, so a single list explains the whole actual-cost figure
without double-counting the money a PO's postings and its service lines both
describe. A PO with no service detail loaded yet still shows its CJI3 posting,
flagged, so cost is never silently dropped.

*Governance* — data freshness, import register, mapping coverage.

Each is a parameterised `SELECT` using named bindings (`:project_key`, `:period_to`, …).
Write your own in the Query library page, or duplicate a system one to start from.

---

## Layout

```
src/main/           Electron main process
  db/               connection, migrations, system query library
  ingest/           workbook reader, column mapping, staging, posting
  services/         read-only query runner, Excel export
  ipc.ts            every channel the UI can call
src/preload/        the contextBridge API — the renderer's only way in
src/renderer/       React UI (pages, components, design tokens)
src/shared/         types shared across the process boundary
tests/              fixtures, end-to-end pipeline test, demo seeder
```

## Tests

`npm test` runs two suites, neither of which needs a window:

- **`db:check`** applies the migrations to a fresh database, asserts every system query
  parses, is read-only and returns rows, and checks the totals.
- **`test:e2e`** drives the real pipeline: it generates SAP-shaped and budget workbooks,
  reads them, auto-maps the columns, stages, posts, then verifies header detection,
  date parsing, negative amounts in parentheses, dimension creation, variance maths,
  supersede-on-re-upload and the Excel export.
