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

## Getting started

```bash
npm install          # also rebuilds better-sqlite3 for Electron's ABI
npm run dev          # launch the app
npm test             # schema + full ingest pipeline checks
npm run dist         # package an installer for the current platform
```

To try it against sample data before your own files are ready:

```bash
npm run demo:seed -- ./demo.db     # writes a demo warehouse + the source xlsx files
COST_DB_PATH=$PWD/demo.db npm run dev
```

The database otherwise lives in the OS user-data directory (Settings shows the path).

---

## Working flow

**Upload → map → review → post.**

1. **Source & file.** Say which module (actual / budget / forecast) and which source
   report this file is, then choose it.
2. **Sheet & data date.** The parser finds the header row underneath any title block and
   guesses the as-of date from the file's own text or name. You confirm both.
3. **Column mapping.** Columns are matched to canonical fields automatically — SAP's
   usual captions are already known (`WBS Element`, `Val/COArea Crcy`,
   `Name of offsetting account`, …). Correct anything wrong; saving the mapping makes the
   next upload of that report a single click.
4. **Review & post.** Every row is validated into staging first. You see the row counts,
   a control total to check against the report footer, which dimension members are new,
   and every rejected row with a reason — before anything reaches the fact tables.

Analysis and Query library then read the posted data; both export to a formatted Excel
workbook that carries a lineage sheet naming the query, the parameters and the row count.

---

## Data model

A star schema, deliberately conventional.

**Facts** — `fact_actual` (one row per SAP posting line), `fact_budget` and
`fact_forecast` (one row per WBS / cost element / scenario / period).

**Dimensions** — `dim_project`, `dim_wbs` (self-referencing hierarchy with a
materialised path, so rollups are a single indexed `LIKE`), `dim_cost_element`,
`dim_vendor`, `dim_period`, `dim_date`, `dim_currency`, and `dim_scenario` for budget and
forecast versions.

**Lineage** — `source_system` → `report_definition` → `import_batch`. Every fact row
points at the batch that created it, and every batch records its data date, file name,
sha256, control total and status. The reporting views read only `POSTED` batches, which
is what makes superseding safe.

**Staging** — `stg_row` holds the raw and mapped form of every row read, so a rejection
can always be traced back to the cell it came from. `column_mapping` stores the per-report
profile; `value_mapping` handles source values that need translating to a dimension member.

**Queries** — `query_library` holds the SQL. Queries shipped with the app are marked
`is_system` and refreshed on every start; anything you write is yours and never touched.
The runner rejects any statement that is not read-only.

Schema: [`src/main/db/migrations/001_core.sql`](src/main/db/migrations/001_core.sql).
Query library: [`src/main/db/systemQueries.ts`](src/main/db/systemQueries.ts).

---

## What ships in the query library

Actuals by WBS · by cost type · by vendor · monthly trend · line-item detail ·
budget vs actual by WBS and by cost element · EAC vs budget with VAC · S-curve ·
top overruns · portfolio summary · data freshness · import register · mapping coverage.

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
