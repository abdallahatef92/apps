# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Working on this repository

Cost Intelligence — an Electron + React + SQLite desktop app for project cost control.
Read `README.md` first for the data model and the reasoning behind it.

## Commands

```bash
npm run dev              # Electron app in development (hot reload)
npm run demo:seed -- <path-to-db>   # write a synthetic demo database for manual UI testing
npm run typecheck        # tsc over both main and renderer, no emit
npm run db:check         # headless schema/query smoke test — no display needed, fast
npm run test:e2e         # the SAP-shaped fixture pipeline (staging → post → reconciliation)
npm test                 # db:check + test:e2e — what CI/before-push actually runs
npm run build            # typecheck + electron-vite build
```

Focused checks for one behaviour at a time, each faster than the full `npm test` and useful
while iterating on that specific area (all under `scripts/run-under-electron.mjs`, no display):

```bash
npm run check:split      # a report split across two overlapping extracts merges, not accumulates
npm run check:unified    # UNIFIED_COST_REGISTER's Detail Substitution merge (PO + order exclusion)
npm run check:partner    # partner_object_type/partner_object capture off a CJI3 posting
npm run check:order      # internal-order settlement → fact_order_line / v_order_line
```

`npm run load:real -- <db> <cji3> <subcontractor> <wbs-tree>` loads genuine extracts and prints
the reconciliation. The files are not in the repo, so this is a manual check.

## Non-negotiables

- **Aggregation belongs in SQL.** Sums, joins, grouping, variance and running totals are
  written as statements in `query_library`, not as TypeScript over an array. The UI
  renders result sets. If a page needs a new number, add or edit a query.
- **Every fact row carries an `import_batch_id`**, and every batch carries a `data_date`.
  A code path that writes a fact without a batch is a bug.
- **Reporting views read `POSTED` batches only.** That is what makes superseding work;
  don't query `fact_*` directly in a report — go through `v_actual` / `v_revenue` /
  `v_posting` / `v_budget` / `v_forecast` / `v_service_line`.
- **Cost and revenue are not the same number.** A CJI3 export carries income on
  4xxxxxxx accounts as negative amounts. `v_actual` is cost only; `v_revenue` is income
  as a positive; `v_posting` is both. Never write a "total actuals" query against
  `v_posting` — it silently nets billing off spend.
- **Service lines are never actual cost.** `fact_service_line` is the sub-ledger behind
  a purchase order whose money is already in `fact_actual`. Reconcile the two, never
  add them.
- **Detail Substitution is the general pattern, not a subcontractor special case.**
  `fact_service_line` carries nothing subcontractor-specific (po_no, vendor, description,
  quantities, amount) — a second PO-based detail report (equipment rental, materials
  reconciliation, whatever the next category is) loads into the same SERVICE module and
  joins into `UNIFIED_COST_REGISTER` with no new SQL, as long as it shares the PO key.
  `v_service_line.report_name` is what keeps two such sources distinguishable once both
  are loaded — never drop it when touching that view. A detail source with a different
  join key (not PO number) or a genuinely different shape needs its own fact table, on
  the same footing as `fact_service_line` — see "Adding a source report" below.
- **Cost type is resolved in the view, never baked into the dimension.** The mapping
  lives in `cost_type_rule` (ordered, matching cost element and/or document type by
  `GLOB`, first match wins) and `v_posting` applies it per posting row — because
  `document_type` is on the fact, not on `dim_cost_element`, and because a rule change
  must correct cost already loaded. `dim_cost_element.cost_type` holds only what a source
  file explicitly stated, which still outranks a rule; never write an inferred value
  there, and never re-introduce account ranges in `importer.ts`. The set of cost types
  itself is data, not a CHECK constraint: `dim_cost_type` holds the code, label, icon
  and colour for each one, and `dim_cost_element.cost_type` / `cost_type_rule.cost_type`
  are a foreign key into it. Settings › Cost types lets the user add, rename or re-icon
  a type; the original six (`LABOR`, `MATERIAL`, `SUBCONTRACT`, `EQUIPMENT`, `INDIRECT`,
  `OTHER`) are seeded with `is_system = 1` and can be renamed but never deleted — the
  account-range rules and `OTHER`'s role as the resolver's catch-all name them by code.
- **Work package coding is keyed on the line's own identity, not its GL pattern or WBS
  location.** Unlike cost type, there is no `GLOB` rule engine here — `material_work_package`
  maps one exact `material_code` (SAP's material number, MATNR, carried in CJI3's own
  "Material" column, dimensioned as `dim_material` and captured on `fact_actual.material_key`
  the same way `dim_vendor`/`vendor_key` are) to a package for MATERIAL cost,
  `cost_element_work_package` maps one exact
  `cost_element_code` to a package for every other cost type, and `service_work_package`
  maps one exact `(service_code, service_text)` pair from `fact_service_line` for
  SUBCONTRACT (a PO's own GL account is usually one generic subcontract account shared by
  many different service items, so subcontract package identity lives one level down, on
  the PO's detail report, not on the posting). A MATERIAL line with no material number
  (an older extract, or the column left blank) stays unallocated — it never falls back to
  the cost element, which several different materials commonly share. Every cost type
  other than MATERIAL/SUBCONTRACT defaults to the seeded `INDIRECT` catch-all
  (`is_system = 1`, undeletable, same role `cost_type`'s `OTHER` plays) but stays
  reviewable via `cost_element_work_package` too. `v_posting` (→ `v_actual`/`v_revenue`)
  resolves MATERIAL/other work packages per row but leaves SUBCONTRACT rows `NULL` — that
  split is resolved later, off `v_service_line` detail, mirroring the Detail Substitution
  pattern (`PKG_SUMMARY` pulls subcontract package cost from `v_service_line`, excluding
  the matching PO's `v_actual` posting, exactly like `UNIFIED_COST_REGISTER` does for
  actual cost itself — a PO with no detail loaded yet falls into `(unallocated)`, never
  silently dropped). Budget carries its own package code directly (a mapped upload
  column, `fact_budget.work_package`, auto-vivifying a bare `dim_work_package` row the
  same way `wbsKey()`/`costElementKey()` auto-vivify their own dimensions) — there is no
  GL-level ambiguity on the budget side the way there is for a posted SAP actual line.
  The Work packages page (`src/renderer/src/pages/PackageMapping.tsx`, its own nav entry
  under **Data** — not Settings, since this is a recurring classification workflow, not
  an admin setting) is where packages are defined and where materials/service items are
  coded; never touch `dim_wbs.package`, which is a free-text WBS-master field and not
  this system.
- **Accrual is a manual estimate, but it still goes through staging.** `ACCRUAL` is a
  module like any other — `fact_accrual` / `v_accrual`, staged and posted via the normal
  upload wizard — for cost incurred but not yet posted in SAP (e.g. "ADD/OMM",
  "Provision"). It carries no scenario, unlike budget/forecast, because it is one
  running set of estimates rather than multiple named versions, so it falls back to
  batch superseding like budget/forecast/master data. `fact_actual.is_accrual` is
  unrelated dead weight from an earlier idea — never wire it up; a real accrual belongs
  in `fact_accrual`, not stamped onto a posted SAP extract.
- **Source reports interleave subtotal rows.** Anything that reads a spreadsheet must
  respect `report_definition.detail_key_fields`; rows with those fields blank are
  SKIPPED, and only rows with `stg_row.status = 'VALID'` may post.
- **A posting line owns its identity.** `NATURAL_KEY` in `importer.ts` names the fields
  that identify a row (for a CO line item: document number + posting row + fiscal year,
  which is SAP's BELNR + BUZEI + GJAHR). It is stored as `line_uid`, unique per project,
  and posting upserts on it, so extracts that overlap — a report split by month, or
  re-run over a wider period — merge instead of accumulating. Never dedupe by file, by
  period, or by batch when the rows carry a key.
- **Never trust a key that repeats.** If `line_uid` collides inside one file, the key
  does not identify a line and using it would silently drop real rows. `postBatch` falls
  back to plain inserts plus batch superseding, and the import screen says so.
- **Batch superseding is the fallback only.** It runs when a source has no usable line
  identity. It is scoped by the projects the facts actually landed on, never by
  `import_batch.project_key` — that is a wizard hint and differs between two uploads of
  the same file.
- **Nothing reaches a fact table without passing through staging.** Read → map →
  validate into `stg_row` → post. The user must be able to see what will happen first.
- **The renderer has no Node and no database access.** Everything crosses via a channel
  in `src/main/ipc.ts` and the bridge in `src/preload/index.ts`.

## Charts

Chart colours come from the validated palette in `styles.css`: eight categorical
slots assigned in fixed order and never cycled, one sequential blue ramp for
magnitude, a blue↔red diverging pair with a neutral midpoint for signed variance,
and a reserved status set that must never double as a series. Before changing any
of them, re-run the dataviz validator against `--surface #121822`.

Never use a dual axis, never colour by rank (a filter must not repaint the
survivors), and never let a null read as zero — an element with no budget is
neutral on a diverging scale, not an overrun the size of its spend.

How an analysis is drawn lives in `query_library.viz_json` beside its SQL, so a
report is one object and a user-written query can describe its own chart. Headline
KPIs come from a separate stored query named by `viz.headline` — never from summing
the result table in the UI.

## Changing the schema

Add a numbered file in `src/main/db/migrations/` and register it in the `MIGRATIONS`
array in `src/main/db/index.ts`. Never edit an applied migration — existing installations
have already run it.

System queries are the exception: they live in `src/main/db/systemQueries.ts` and are
upserted on every start, so fixing one is a normal code change. Queries with
`is_system = 0` belong to the user and must never be modified or deleted by the app.

## Adding a Detail Substitution source

Before writing anything, check whether the new report is PO-based with the usual
shape (a purchase order, a vendor, a description, an amount) — if so it is not a new
report *kind*, it is another instance of `SERVICE`: map it via a new `report_definition`
row and a column mapping, same as any upload, and it joins into
`UNIFIED_COST_REGISTER` automatically. Confirm with `DETAIL_SOURCES` that it shows up
as its own row.

Only build a new fact table when the join key genuinely is not a PO number, or the
shape has no sensible mapping onto `fact_service_line`'s columns. In that case: a new
fact table alongside `fact_service_line`, a view exposing `report_name` the same way,
and a second CTE in `UNIFIED_COST_REGISTER` keyed on the new field — the "PO with
detail" exclusion in `direct_cost` needs to check the new key too, or a posting could
be excluded from actuals without anything replacing it.

An internal order settling into a WBS is one such non-PO case, implemented in full:
CJI3 names the receiver directly on the posting via `partner_object_type` ("Order")
and `partner_object` (the order number) — captured on `fact_actual` since migration
008. Its line-item detail lives in `fact_order_line` / `v_order_line` (migration
009), the ORDER module — a CO line item keyed on an internal order rather than a
WBS, with no natural key of its own, so it falls back to batch superseding like
budget, forecast and master data. `UNIFIED_COST_REGISTER` excludes a `direct_cost`
row when its `partner_object` has detail loaded, and unions in `order_detail`
alongside `detail_lines`, mirroring the PO exclusion exactly, just on a different
column. Only `category = 'WBS'` rows in `fact_order_line` count as detail loaded or
enter the register — `category = 'CTR'` means the cost still sits on a cost centre
and has not settled to any project's WBS yet, so it must never be summed as project
cost. The flag column generalised from `po_missing_detail` to `missing_detail`
accordingly — it now covers a PO or a settled order with no detail loaded.
`ORDER_SETTLEMENTS` and `ORDER_DETAIL_SOURCES` are the order-side equivalents of
checking CJI3 postings and `DETAIL_SOURCES`.

## Adding a source report

Most new report shapes need no code — a `report_definition` row (including its
`detail_key_fields`) plus a saved column mapping. Only add to
`src/main/ingest/targetFields.ts` when a genuinely new canonical field is required, and
add the source's caption to that field's `synonyms` so the next file auto-maps.

Synonym order is significant: the first synonym that matches a column wins, which is how
`wbs_code` prefers "WBS Element" over the vaguer "Object". Avoid short generic synonyms
("type", "name") — they get claimed by unrelated SAP columns and quietly mis-map a whole
file.

Modules are rows in `module_type`, not a CHECK constraint, so a new module needs a seed
row and a branch in `postBatch` — no table rebuild.

## Renderer architecture

Pages live in `src/renderer/src/pages/` and are wired in exactly two places in `App.tsx`:
the `PAGES` array (nav entry, glyph, subtitle) and the `page === '...'` switch in the
`content` div. Both need updating to add a page — there is no router.

`useApp()` (defined in `App.tsx`) is the only way a page reaches shared state: `projectKey`
/ `project` (the picker in the top bar), and `dataVersion` — bumped by `touch()` after a
successful import, which is how a page knows to re-run its queries without a manual
refresh. A page that fetches once in a plain `useEffect(() => ..., [])` will go stale after
the next import; depend on `[projectKey, dataVersion]` instead.

Two established page shapes — reuse one rather than inventing a third:
- **Single-query explorer** (`Analysis.tsx`, `QueryLibrary.tsx`): pick one stored query,
  render it via chart/table/SQL tabs. This is what `query_library.viz_json` is for.
- **Assembled dashboard** (`Dashboard.tsx`, `SubcontractorAnalysis.tsx`,
  `MaterialAnalysis.tsx`): several stored queries fetched into one screen — a `<KpiStrip>`
  (renders every column of a single-row headline query generically, so a new KPI is a SQL
  change, not a component change), a couple of charts, a `<DataTable>` detail table. Reach
  for this shape for a new "insights + details" report.

`Reports.tsx` is the one bespoke page (a collapsible cost-type/GL/WBS pivot with sortable
columns and a shared filter bar) — copy its patterns only when the data is genuinely
tree-shaped; a flat KPI+chart+table screen belongs in the assembled-dashboard shape above.

Chart components (`src/renderer/src/charts/`: `BarChart`, `Treemap`, `LineChart`,
`Heatmap`, `Sparkline`) and `<DataTable>` all take a `QueryResult` plus column names, never
a plain array — this is what keeps "aggregation belongs in SQL" true on the frontend too.
`DataTable` already has free-text filtering, click-to-sort, a `signColumns` prop (red/green
by sign) and a `flagColumn` prop (a 0/1 column that tints the row and hides itself from the
rendered table) — use these instead of building bespoke table chrome. It also owns a
workbook-style toolbar for free: a "Group by" dropdown auto-populated from the result's own
non-numeric columns (grouping and the subtotal/grand-total rows it produces are a client-side
rollup of numbers the query already returned, the same category of operation `Reports.tsx`'s
`buildTree` does, not a second source of truth for them) and a column-visibility picker. A
column only ends up in a subtotal if `isSummableColumn` (`lib/format.ts`) says so — numeric-
looking identifier columns (`_key`, `_id`, `_no`, `_code`) are deliberately excluded from
summing even though they're right-aligned like numbers, since summing a document number is
never meaningful. The first visible column is sticky or a wide result. Any container wrapping
a `<DataTable>` in a CSS grid (like `.split`) must give its own last child `min-width: 0`, or
the grid track grows to fit the table and the whole page scrolls sideways instead of the table
scrolling internally — `.split > *:last-child` already carries this rule; copy it onto any new
grid wrapper that can hold a wide table.

For a page that assembles several related queries into switchable tabs (an "Excel workbook"
with multiple sheets) rather than one long scroll, use `<SheetTabs>`
(`src/renderer/src/components/SheetTabs.tsx`) — it takes sheets whose content is already
fetched up front (same as the assembled-dashboard shape above), so switching tabs never
re-queries anything. `SubcontractorAnalysis.tsx` and `MaterialAnalysis.tsx` are the reference
usage: a `<KpiStrip>` and any context banners stay above the tab strip (they're portfolio
context, not sheet-specific), and the tabs switch only the charts/tables below.

For a pannable/zoomable node-and-edge canvas (`SchemaDiagram.tsx`, `LineageGraph.tsx`), use
`useGraphCanvas` + `buildExportSvg`/`rasterizeSvgToPng` from
`src/renderer/src/components/GraphCanvas.tsx` rather than re-deriving wheel-zoom/drag-pan/SVG
export a third time — it owns the viewBox math, the click-vs-drag guard, and the "clone the
`<svg>`, strip it to its natural size, give it an opaque background" export step. A page only
supplies its own node/edge layout (`useMemo` keyed on its data) and calls `canvas.fitTo(w, h)`
when that layout changes.

## Data lineage (`LineageGraph.tsx` / `src/main/services/lineage.ts`)

The Lineage page draws a source report's path — report → staging → fact table → views → the
queries that read them — entirely from introspection, the same "don't duplicate what's already
true in the schema" principle as the Schema diagram. Two things are worth knowing before
touching either side of it:

- **`FACT_TABLE`** in `src/main/ingest/importer.ts` (exported) is the one place that says which
  fact table a module writes to — `postBatch` and the lineage graph both read this same map, so
  a new module updates it once and both sides pick it up. `MASTER` has no fact table (it writes
  `dim_wbs` via `postWbsMaster`) and is special-cased as a dimension node.
- **Which queries read a view is found by scanning SQL text, not a stored mapping.**
  `query_library.module` is a display grouping only (a query tagged `ACTUAL` can and does also
  read `v_service_line`/`v_order_line`) — `buildLineage()` instead scans every `FROM`/`JOIN`
  token in a query's `sql_text` (not just the outer clause, so a CTE that unions several views,
  like `UNIFIED_COST_REGISTER`, still resolves correctly) and keeps the ones matching a real
  `sqlite_master` name. Never add a hand-curated "this query depends on these views" field —
  the whole point is that it can't drift from what a query's SQL actually does.

## Explainable anomaly detection

`ANOMALY_TRANSACTIONS` and `MATERIAL_RATE_OUTLIERS` (in `systemQueries.ts`) are the
pattern for "flag this for review": every check is a plain SQL predicate over a baseline
computed with a window function (e.g. `AVG(ABS(amount)) OVER (PARTITION BY cost_element_code)`,
with a minimum-sample-size guard so a thin GL doesn't flag itself) — never a black-box
score. The query concatenates every predicate that fired into one `reasons` string per row,
and the page's own hint text lists the checks in plain language. Add a new check as another
`CASE WHEN ... THEN '<reason>; ' ELSE '' END ||` branch, not a separate feature.

## A query-runner gotcha worth knowing before you debug it again

The generic query runner (`coerce()` in `src/main/services/queryRunner.ts`) binds a
numeric-looking string parameter (e.g. a GL code like `"30301100"`) as a number so it can
match an INTEGER primary key. That silently breaks an equality filter against a TEXT column
holding the same digits — SQLite's better-sqlite3 binding renders the number back with a
trailing `.0`, so `cost_element_code = :code` never matches. The fix used in
`COST_BY_TYPE_GL_TXN` is to compare against both the raw parameter and a round-tripped
`CAST(CAST(:code AS INTEGER) AS TEXT)` — the second branch recovers the numeric case and is
a harmless no-op for a genuinely alphanumeric code.

## Before you push

```bash
npm run typecheck && npm test && npm run build
```

`npm test`'s fixtures live in `tests/makeFixtures.ts` — extend them when you add parsing
behaviour, and assert the resulting numbers, not just row counts. The SAP-shaped fixtures
reproduce the real traps (subtotal rows, income postings, the Title/Description swap, the
PO sub-ledger); keep them that way.
