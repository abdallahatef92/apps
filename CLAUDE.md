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
- **The project cut-off is applied inside `v_posting`** (`018_cutoff.sql`, spec in
  `docs/flow-redesign.md`). `project_cutoff` holds one date per project; a posted line counts
  when its posting date (else its period's end date) is on or before it, so `v_actual`,
  `v_revenue` and every query over them respect it with no change. `v_posting` is a filter
  over `v_posting_all` (same columns, no cut-off) — only status queries that count what is
  held back (`CUTOFF_STATUS`) may read `v_posting_all`, never a report. Held-back lines
  stay in `fact_actual`. `v_order_line`, `v_accrual` and budget/forecast are not cut off
  yet, so a PO reported from its service-line detail ignores the cut-off for those
  sources (`v_service_line` carries the cut-off as `pend_reason`/`bucket`, see below).
  `PKG_ACT_SQL` in `systemQueries.ts` is the one work-package split of actual cost shared by
  `PKG_SUMMARY` and `FLOW_STATUS`.
- **Cost and revenue are not the same number.** A CJI3 export carries income on
  4xxxxxxx accounts as negative amounts. `v_actual` is cost only; `v_revenue` is income
  as a positive; `v_posting` is both. Never write a "total actuals" query against
  `v_posting` — it silently nets billing off spend.
- **Certificates replace CJI3 subcontract postings, per PO; they are never added to them.**
  `fact_service_line` is the sub-ledger behind a purchase order whose money is also in
  `fact_actual`. The headline actual (`v_actual_cost`) takes, for every PO that has
  certificates loaded, the counted certificate lines (To date, `pend_reason IS NULL`) and
  sets that PO's CJI3 SUBCONTRACT lines aside; a PO with no certificates keeps its CJI3
  amount. The set-aside amount is reconciled against the certificates (`COST_SOURCE_RECON`),
  never summed with them — the same rule as MB51. Any other query that reads both
  `v_actual` and `v_service_line` must make the same choice, not add them.
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
  pattern (`PKG_SUMMARY` reads `v_actual_cost`, where the certificate lines replace the
  matching PO's CJI3 posting — a PO with no certificates loaded yet falls into
  `(unallocated)`, never silently dropped). Budget carries its own package code directly (a mapped upload
  column, `fact_budget.work_package`, auto-vivifying a bare `dim_work_package` row the
  same way `wbsKey()`/`costElementKey()` auto-vivify their own dimensions) — there is no
  GL-level ambiguity on the budget side the way there is for a posted SAP actual line.
  The Work packages page (`src/renderer/src/pages/PackageMapping.tsx`, its own nav entry
  under **Data** — not Settings, since this is a recurring classification workflow, not
  an admin setting) is where packages are defined and where materials/service items are
  coded; never touch `dim_wbs.package`, which is a free-text WBS-master field and not
  this system. The Materials tab is built for real scale (hundreds of materials), not the
  handful cost type/subcontract coding sees: it groups by the material code's first two
  digits by default (real SAP numbering categorises there), not by current package, so one
  bulk pick codes a whole category; and it round-trips through Excel
  (`workPackages:exportMaterialMapping`/`importMaterialMapping` in `ipc.ts`, reusing the
  generic `exportResult()` writer) rather than only one-row-at-a-time in the UI — the
  exported `work_package` column is what a re-imported file is matched back on, so never
  rename it without updating both sides. A row with no `material_code` is filtered out of
  this tab's query entirely (there's nothing to key a coding on), not shown as a dead-end
  bucket the way `service_work_package`'s uncoded-detail case is. `dim_work_package` ships
  seeded with the 16 CSI MasterFormat divisions (`015_csi_packages.sql`) alongside
  `INDIRECT`, `is_system = 1` with the same rename-but-not-delete protection cost type's
  six get, `group_label` set to Civil/Arch/MEP straight from CSI's own grouping — so a
  fresh database's Packages tab isn't empty and a package-grouped report already reads in
  a sensible hierarchy. The Materials tab's grouping is two levels (`groupBy1`/`groupBy2`
  in `MaterialCodingTable`) — group by package, then by code prefix within each, or the
  reverse — reusing `buildMaterialGroups()` for both levels rather than a second grouping
  function; picking the same dimension for both collapses back to one level rather than
  showing a pointless single-item nesting. Neither a leaf row nor a group/sub-group
  header renders its own `PackagePicker` inline — at CSI's 16-plus-INDIRECT scale, once
  each button also carries its code (not just its icon), that control is wide enough to
  wrap across several lines and made every row it touched tall and hard to scan. Every
  row instead carries a plain checkbox (a group header's own checkbox is tri-state:
  all/some/none of its rows selected), and there is exactly one `PackagePicker` on the
  page — a bar above the table, always rendered (an idle hint, or "N selected" once
  anything is checked) — that applies to every currently-checked row at once, whether
  that's one row, a hand-picked few across groups, or an entire group checked via its
  own tri-state box, then clears the selection. This bar and the column-header row are
  both `position: sticky`, stacked so they stay visible together while a long, scrolled
  list is checked — this only works because the Materials tab's own `.table-wrap`
  overrides the shared class's `overflow: auto` back to `visible` (`overflow: auto`
  makes an element the containing block for its own sticky descendants regardless of
  whether it ever actually scrolls, which silently breaks `position: sticky` whenever,
  as here, the real scrolling happens on `.content` instead). The bar's rendered height
  is measured with a `ResizeObserver` (`selBarHeight` in `MaterialCodingTable`) and fed
  to the header row's own sticky offset as a `--sel-bar-h` CSS variable on the `<table>`
  — never hardcoded, because the bar's own height isn't fixed: it can wrap to more than
  one line depending on window width or simply how many work packages exist. A group
  header and the page-level summary line both report their own unallocated count and %
  of total spend (of the whole tab's total, not the current filter), and a leaf row
  with its own explicit assignment carries a small inline "✕" next to its badge to
  clear just that row, without needing the checkbox+bar flow for a single undo.
  `buildMaterialGroups()` takes the table's active `sort` and, when the sorted
  column is Amount or Postings, orders the groups themselves by that same
  total — a click on those headers otherwise only reordered rows inside each
  group while the groups stayed in identity order (prefix numeric, or CSI
  order for a package group), which looked like the sort silently did nothing.
  Every other sort column keeps identity ordering, since a group has no single
  code/description of its own to rank by. Unallocated gets weight beyond plain
  text: the "N unallocated" clause (group header and page summary) renders in
  the warning badge ink (`--badge-warn-ink`, the reserved `--warning` hue darkened so it
  stays readable on light themes), a leaf row's own `UNALLOCATED` is a tinted
  pill (`UnallocatedBadge`, `PackageBadge`'s shape in warning color) rather
  than plain text, and a group header carries a small coded/uncoded meter —
  one fill whose color is the severity (`--good` once the group is fully
  coded, `--warning` otherwise), track the same color at low alpha rather
  than a second hue, per the dataviz skill's meter contract, not a two-tone
  stacked bar. `GroupedPackageTable` (the Subcontractors and Other tabs —
  one shared component, so fixing it fixes both) carries every one of these
  concepts too, not a separate, older pattern: checkbox rows and one sticky
  `.sel-bar` picker instead of an inline `PackagePicker` per row/group,
  `.table-wrap` overridden to `overflow: visible` so sticky actually reaches
  `.content`, a text filter, sortable Postings/Amount that reorders groups
  themselves (`groupByPackage` takes the same `sort` shape
  `buildMaterialGroups` does), and the warning-colored/`UnallocatedBadge`/
  `CoverageMeter` unallocated treatment. `CoverageMeter` lives at module
  scope (not closed over `MaterialCodingTable`) specifically so both tables
  share one implementation, and the sticky-header CSS selector is named
  `.pkg-sticky-thead`, not `.material-thead`, for the same reason.
  `GroupedPackageTable` also splits its own merged identity cell into two
  real columns (`codeLabel`/`renderCode`, `descLabel`/`renderDescription` —
  Service code/Description on Subcontractors, GL/Cost type on Other) instead
  of one `<td>` with an inline secondary span, matching Materials' Code |
  Description split. Its grouping generalizes `buildMaterialGroups()`'s
  approach (`buildGenericGroups`, `Group<T>.key` instead of `.code`) behind
  two **optional** props, `groupKey`/`groupKeyLabel`: when a caller supplies
  them (Subcontractors: the service code's own first three characters, e.g.
  `S0401` → `S04` — a service item's real category prefix, the direct
  analog of a material's two-digit prefix) the table gets the same
  two-level `groupBy1`/`groupBy2` selector Materials has (`'key' | 'po' |
  'package' | 'none'`); when omitted (Other — no natural prefix asked for
  there) it keeps exactly one grouping, by current package, unchanged from
  before. A group header also carries `{pct(g.amount)}% of total`, matching
  Materials exactly. `ServicePackageCombination` (Subcontractors) carries
  its own `po_no` too — `loadServicePackageCombinations()`
  (`src/main/ipc.ts`) groups `v_service_line` by `(po_no, service_code,
  service_text, work_package)` rather than collapsing `po_no` away, purely
  so the browsing grain can show which PO a slice of cost came from and
  offer PO as a third `GroupedPackageTable` dimension (`poColumn`) — the
  coding key itself is still `(service_code, service_text)` alone
  (`service_work_package`'s own primary key), unchanged: the same service
  item recurring across several POs shares one assignment, and assigning
  from any one of its PO-rows updates every row sharing that code/text,
  across every PO, immediately. `rowKey`/`savingKeys` for this tab include
  `po_no` too, so two rows that happen to share a code/text but sit on
  different POs never collide in the selection or saving-indicator state.
  **The mapping tables are project-scoped** (`016_project_scoped_mapping.sql`)
  — `material_work_package`, `cost_element_work_package` and
  `service_work_package` all carry `project_key` as part of their primary
  key now, not just the line's own identity, because two projects routinely
  code the same material or GL account into different packages and the
  workflow is "code one project's register at a time," never "code the
  warehouse." `dim_work_package` (the package catalog itself) stays a
  shared, global taxonomy — only the mapping is per-project. Every
  correlated work-package subquery in `v_posting`/`v_service_line`/
  `v_accrual` matches on `project_key` alongside the line's own code, and
  `loadMaterialPackageCombinations`/`loadOtherPackageCombinations`/
  `loadServicePackageCombinations` (`src/main/ipc.ts`) all take a
  `projectKey` argument and filter `v_actual`/`v_service_line` by it too —
  the combinations list itself, not just the assignment lookup, was
  previously unscoped and summed every project's postings together under
  one material/GL/service code. `workPackages:assignElement`/
  `assignMaterial`/`assignService`/`exportMaterialMapping`/
  `importMaterialMapping` all take `projectKey` as their first IPC
  argument for the same reason. `PackageMapping.tsx` reads `projectKey`/
  `dataVersion` from `useApp()` (it previously read neither) and reloads
  on either changing, the same dependency every other page keys its
  queries on; with no project selected, every combinations list is empty
  rather than showing unscoped, cross-project data. An existing
  assignment made before this migration was copied forward onto every
  project already in the database (rather than dropped), so each project
  starts from that shared history as its own independent baseline.
- **The subcontract cost report is SQL over two uploads.** Certificate lines (ZSCPROG01,
  SERVICE) carry the approval flag (`is_approved`, 'Character 1' = X), opening flag
  (`is_opening`, 'Flag' = X), `tax_code`, `profit_center`, `package_no` and `split_count`
  (017_subcontract_report.sql). A flag is parsed at staging only when its column is
  mapped; a NULL flag means an older upload without the column, and the views read a NULL
  approval as approved rather than turning old lines into pending. The report's rules
  are columns of `v_service_line`, not TypeScript: `net_rate` (an A2 contract's gross
  price divided back by `dim_tax_code.vat_rate`), `line_class` (Adjustment / Qty only /
  Normal) — Normal only when `abs(amount − qty × net_rate) <= max(1, 0.1% of amount)`,
  otherwise Adjustment (paid-% change, hold release, reversal, re-price) — and `report_qty`
  (Normal = the certificate qty; Adjustment = amount ÷ the rate its PO line was certified
  at, a window over po/item/package/line on Normal lines, else its own net rate;
  `rate_used`/`rate_src` say which), `certificate_id` (PO | invoice serial),
  `service_text_norm` (the tool's `normText`, in SQL), `tow` (Type of Works from the PO's
  ZSCSRV1 lines; `dim_tow_order` holds a user order), `trade` (chars 2–3 of an S-code, else
  the first char, labelled from `dim_sc_trade`) and `is_other_pc` (not the project's most
  common profit centre). The project cut-off (migration 019) is applied inside
  `v_service_line` without dropping rows: `pend_reason` is 'Not approved' / 'No date' /
  'After cut date' (NULL = counted) and every pending line has `bucket = 'PENDING'`;
  otherwise `bucket` is OPENING or the period. An undated certificate line has no period
  (the importer no longer gives it the batch period). `report_month` is the month of the
  cut-off, else the latest counted month, and `report_bucket` splits counted lines into
  OPENING / PREVIOUS / THIS_MONTH (To date = all three, Opening included). Both public
  views sit over `v_service_line_core`; `v_service_line_all` is the same without the cut-off
  (status counts only, never a report). The PO service-line register (ZSCSRV1) is its
  own module, `PO_SERVICE` → `fact_po_service_line` / `v_po_service_line`, keyed on
  PO + item + service line. `v_service_line_po_match` matches each certificate line to
  it in tiers: Exact (PO + item + code + text + price), Text (price differs), Service
  code only, Not found; item numbers are compared without leading zeros. Staging keeps
  the largest subtotal row as `import_batch.control_total` when it is at least the size
  of the lines themselves (SAP's grand-total footer, split repeats included), so the
  Checks tab can compare the file's own total. Every posted SERVICE batch is copied into
  `service_line_snapshot`, because the fact table keeps only each line's latest version;
  "changes since last load" diffs two snapshots. 'Profit Ctr' no longer maps to the
  project on a SERVICE upload (the project comes from the wizard); 'Tx' is the tax code,
  and caption matching keeps non-Latin letters so 'نوع العقد' maps to `contract_type`.
  Subcontractor Analysis reads it through the `SC_*` stored queries: `SC_REPORT_KPI`
  (the strip above the tabs), `SC_MONTH_BY_TRADE` (top seven trades plus 'Other trades',
  `series_order` fixing each trade's colour slot), `SC_TRADE_SUMMARY`,
  `SC_ACTIVE_SUBS_BY_MONTH`, `SC_TOP_SERVICES`, `SC_QTY_RECONCILIATION` and `SC_CHECKS`.
  A service's unit is one SQL fragment (`SC_UNIT_SQL`: PO UOM, then the code suffix, then
  Arabic unit words in the text), shared by the queries that need it. A check with
  nothing to compare against — no footer in the file — reads 'not checked', never 'ok'.
  `scripts/dump-queries.mjs` evaluates `systemQueries.ts` through esbuild, so a query
  assembled from such fragments is checked by `db:check` fully expanded.
  The Changes tab reads `service_line_snapshot` only (`SC_LOAD_HISTORY`,
  `SC_CHANGES_SUMMARY`, `SC_CHANGES`, one shared `SC_CHANGES_SQL` fragment): the two
  newest loads per project by `import_batch_id`, compared on `line_uid` as New / Amount
  changed / Approved since last load (counted at its full amount, the workbook's rule) /
  Removed. A line missing from the newer file is reported as Removed but stays in
  `fact_service_line` — posting merges by line identity and never deletes, so the Checks
  tab's "report total vs latest upload" row is what shows the gap.
  Both Excel exports pass their finished buffer through `fixSheetPrOrder()` (`src/main/services/xlsxFix.ts`):
  ExcelJS 4.4.0 writes `<sheetPr>` as tabColor, pageSetUpPr, outlinePr, but the schema needs outlinePr
  before pageSetUpPr, and Excel drops ("repairs") every sheet that has both fit-to-page and row grouping.
  The e2e asserts the order on both workbooks — never remove the wrapper while on ExcelJS 4.4.0.
  **⤓ Excel report** (`sc:exportReport` → `src/main/services/subcontractReport.ts`) writes
  the v2.6 tool's monthly workbook, `<project>_SC_Report_<yyyy-mm>.xlsx`: Summary (cut date in
  B4 = `CutDate`, every figure SUMIFS on Data), Coding, Lists, Service Summary (with rate
  analysis), Service per Month, PO Register, PO per Month, Subcontractor Summary, Invoices
  Register, Checks, Changes, Data, Notes and hidden `_Codes`/`_Meta`/`_Cal`/`_Ref`.
  `subcontractWorkbookV26.ts` is the tool's model + writer ported nearly verbatim
  (`// @ts-nocheck` on purpose — keep it a port, don't rewrite its formulas);
  `subcontractReport.ts` is the typed adapter that feeds it `v_service_line` (classification,
  bucket, pend_reason, tow all come from the view — the writer does not re-classify),
  `v_po_service_line`, `SC_CHECKS`/`SC_CHECK_ROWS`, `SC_LOAD_HISTORY` and `SC_CHANGES`, so
  the workbook and the page read the same rules. Cut date = the project cut-off, else the end
  of the latest counted month; undated/unapproved/after-cut lines are Pending. Coding columns:
  DIV = the service's work package (`service_work_package`), MNL = `dim_cost_type.mnl` of
  SUBCONTRACT (`SUB`; migration 023, edited in Cost types). PKG and Cost element are left blank
  for the user to fill (their own catalogue codes, which the app does not store). Edits typed on
  the workbook's Coding sheet are not read back.
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
  back to plain inserts plus batch superseding, and the import screen says so. The one
  exception is SAP's subcontractor report (SERVICE, `SPLIT_COLLAPSE_MODULES` in
  `importer.ts`): it prints one certificate line once per WBS element it is charged to,
  with identical amount, quantity and VAT. Staging recognises such a repeat, stages it
  SKIPPED ("counted once") and records `split_count` on the kept row. A repeat that
  differs in any of those values is still a real collision.
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
magnitude, an orange↔blue diverging pair with a neutral midpoint for signed variance
(orange = over budget, blue = under — never red/green, per the Power BI layout-design
skill's cost-control semantics; `divergingColor()` in `charts/chrome.tsx` maps a value
onto the arm tokens), and a reserved status set that must never double as a series. Good/bad money
text uses `--ink-good`/`--ink-bad` (blue/orange), not the status colours. Before
changing any of them, re-run the dataviz validator against that theme's `--surface`.

The renderer is themeable: `:root` in `styles.css` is the default `crypto` theme and
`:root[data-theme="technical" | "finance" | "prof"]` blocks override the same tokens
(applied by `src/renderer/src/lib/theme.ts`; values and validation notes in `docs/themes.md`).
Chart and component code uses tokens only — `var(--series-n)`, `var(--seq-n)` /
`var(--seq-ink-n)`, `var(--div-neg-n)` / `var(--div-pos-n)` / `var(--div-ink-n)` — never a
literal hex. A new colour is a new token with a value in every theme block, not a literal in a rule.

The chrome follows the same skill: Sidebar frame with an edge-bar active item, "Tick"
card titles (accent bar before each `.card > h3`), 8px corners, 16px gutters
(`--gutter`), and on a dashboard the KPI row first (Budget, Actual, variance, …),
charts next, tables last.

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

## Material from MB51 / ME2N (`MATISSUE`, `MATPO`, `MATLIST`) and `v_actual_cost`

Material cost can come from SAP material documents instead of CJI3 postings (migration 021).
- `MATISSUE` (MB51) → `fact_material_issue`, keyed on document + year + item (`line_uid`). Every
  movement is stored in SAP sign — receipts and transfers too, because the file's total row
  (`import_batch.control_total`) covers them. `material_movement_rule` (data, `GLOB` on the movement
  type) says which are cost: 221/222/281/282 = P Project, Z21/Z22 = S To subcontractors, 551-556 = X
  Scrap; known non-cost types are `OUTSIDE`, anything else is `UNKNOWN` (a Check, never cost).
  `v_material_movement` classifies all; `v_material_issue_all` = issues with a value, cost-signed
  (`amount`/`quantity` flipped, `sap_*` kept), with `pending_reason`; `v_material_issue` = the same
  held to `project_cutoff` on the posting date. A line with no posting date never counts (no period
  to fall back on, unlike CJI3). A document line pasted twice is staged SKIPPED (counted once).
- `MATPO` (ME2N) → `fact_po_material_line` / `v_po_material_line` (PO + item; `kind` PUR vs STO by
  a numeric vs plant-code supplier; `is_deleted`), `v_po_material_price` = weighted PO price per
  material (deleted lines and stock transfers left out). A line with no material is not loaded.
- `MATLIST` (MM60) writes `dim_material` only (like `MASTER` writes `dim_wbs`): `material_group`,
  `material_type`, `base_unit`. Group resolution: ME2N (most frequent group) > the list > what was
  known; `group_source` records it. The group's name/family/division come from `dim_material_group`.
- **`v_actual_cost` is the headline actual, and it is generalised to every cost category**
  (migration 024, plan rev. 4): *if a category's detail source is loaded for the project, the
  detail is that category's actual cost and the category's CJI3 lines are set aside; otherwise
  CJI3 is the actual.* One mechanism, driven by data: `cost_source_rule(cost_type, source,
  detail_view, match_key, description, is_active)` names each detail source and how a CJI3 line
  is matched to "has detail", read through `v_cost_source_active`. `v_actual_tagged` tags every
  `v_actual` line with the source that replaces it (`aside_source`, NULL = kept; first match
  wins: MB51, CERT, ORDER), `v_actual_set_aside` lists them and `v_actual_cost` is the kept CJI3
  lines (`source` 'CJI3') plus the details, with the same columns as before:
  - `MB51` (cost type MATERIAL, per project): all CJI3 MATERIAL lines of a project that has MB51
    issues loaded (`v_mb51_project`) are set aside; the issues come in as MATERIAL.
  - `CERT` (SUBCONTRACT, per PO): CJI3 SUBCONTRACT lines whose `po_no` has certificates loaded
    (`v_cost_cert_po`, read off the fact table so the cut-off never flips a PO) are set aside; the
    counted `v_service_line` lines come in (`amount_net`, `eff_date` as posting date, work package
    from `service_work_package`). A PO whose certificates are all pending is still "loaded": its
    CJI3 is set aside and the difference shows in the recon.
  - `ORDER` (EQUIPMENT / FLEET / HOUSING and any type whose CJI3 line is an order settlement,
    per order): a CJI3 line with `partner_object_type = 'Order'` whose order has `category = 'WBS'`
    detail (`v_cost_order_detail`) is set aside whatever its cost type (the settlement GL's type
    says nothing about the detail's); the `v_order_line` WBS rows come in with the cost type their
    own GL resolves to through `cost_type_rule` (already done inside `v_order_line` — no second
    copy of the resolver), held to the cut-off by their period's end date. `CTR` rows never count.
    An ORDER MATERIAL row of a project with MB51 is left out (MB51 already covers it).
    The ORDER rows are switched on/off as a source; the named cost types on them are descriptive.
  - `LABOR` (Labour Allocation Form) and `DEPRECIATION` (Asset Movement Sheet) have rule rows with
    `is_active = 0` and a view that does not exist yet: the modules are future work and the
    mechanism is ready — activating a rule needs its branch in `v_actual_tagged` / `v_actual_cost`.
  - G&A has no detail source (CJI3 only).
  - **Service MNL** (`service_mnl(project_key, service_code, service_text, mnl)`, `mnl` SUB/LAB/EQU,
    exposed as `v_service_line.mnl`, default SUB; IPC `workPackages:assignServiceMnl`): a certificate
    service coded LAB / EQU reports under LABOR / EQUIPMENT in `v_actual_cost`. A sibling table, not a
    column of `service_work_package`, because that assign path deletes and re-inserts a row and an MNL
    can exist with no package. The Subcontractors report still lists the service (it is still a
    subcontract) with its `mnl`.
  - `COST_SOURCE_RECON(:project_key)`: per source and cost type (plus a TOTAL row per source), CJI3 set
    aside vs detail amount, difference (detail − CJI3: timing / not yet in the detail), `detail_loaded`
    and `cji3_kept`. Never add the two sides.
  On `v_actual_cost`: `KPI_PROJECT`, `FLOW_STATUS`, `S_CURVE`, `ACT_MONTHLY_TREND`, `ACT_BY_COST_TYPE`,
  `COST_HEATMAP`, and all of `PKG_SUMMARY` / `FLOW_STATUS` work-package actual (`PKG_ACT_SQL` is now one
  read of it: certificates carry their service's package, a PO without certificates stays CJI3 and
  `(unallocated)`). Still on CJI3 `v_actual`: everything GL-level (Reports pivot, anomalies,
  `UNIFIED_COST_REGISTER`, the Material analysis pages), because the detail sources have no CJI3 GL
  account — `UNIFIED_COST_REGISTER` does its own PO / order substitution and ignores the cut-off for
  detail lines. `MAT_RECON` (in `materialQueries.ts`) reconciles MB51 vs CJI3 by month. Never add a
  detail source on top of its CJI3 category — swap, per project / PO / order. The cost types FLEET,
  HOUSING, DEPRECIATION and GA are seeded (is_system) with no GL rules: the user maps GLs in Cost types.
  The old custom `ASSET_DEPRECIATION` type was repointed to `DEPRECIATION` (rules and cost elements)
  and kept, labelled "(legacy)".
- **⤓ Excel report on the Material page** (`material:exportReport` → `src/main/services/materialReport.ts`)
  writes the Material Cost Report v1.2 workbook, `<plant>_Material_Report_<yyyy-mm>.xlsx`: Summary,
  Coding, Lists, Material Summary, Material per Month, PO Register, Stores Transfers, Checks, Data, Notes
  and hidden `_Codes`/`_Meta`/`_Cal`, live (cut date in `Summary!B4`, SUMIFS on the Data sheet).
  `materialWorkbook.ts` is the tool's writer and `materialEngine.ts` its `build()` ported nearly verbatim
  (`// @ts-nocheck` on purpose — keep them ports); `materialReport.ts` feeds the engine from
  `v_material_movement`, `v_po_material_line`, `dim_material`/`dim_material_group` and the work packages,
  and takes the Checks sheet from `MAT_CHECKS`/`MAT_CHECK_ROWS` and asserts To date = `MAT_KPI`. Cut date =
  `project_cutoff`, else the end of the latest month with counted issues. PKG = `material_work_package`,
  MNL = `dim_cost_type.mnl` of MATERIAL (`MAT`, migration 023). Cost element is left blank for the user to
  fill (their own catalogue codes, which the app does not store); codes typed in the sheet are not read back. The round-trip sheets
  `_Ref`/`_Mvt` and the Changes sheet (no material snapshot yet) are not written.

## Live CJI3 from S/4HANA (`S4_JOURNAL_ITEMS`, migration 028)

The CJI3 card on Home has a **⟳ SAP** button (`SapConnect.tsx` as a Home panel): the user's own SAP login pulls
journal entry items over OData (`API_JOURNALENTRYITEMBASIC_SRV`, `src/main/sap/odata.ts` + `pull.ts`, leading ledger
`0L`, WBS prefix = the project code by default). A pull is staged by `stageRows()` — `stageFile()` only reads the sheet
and calls it — and reviewed with `StageReview`, so it obeys every staging rule; lines are keyed document + ledger line +
fiscal year. It is an **alternative** to the CJI3 file for build step B04, never an addition: FI and CO document numbers
never share a `line_uid`, so the SAP panel blocks posting while the project has another ACTUAL source, and
`BUILD_CHECKS` warns on B04 if both end up loaded. The password never goes in the database (encrypted with
`safeStorage` beside the app if remembered); requests use Electron `net.fetch` (system proxy and certificate store).
An on-premise server's URL is the application server + HTTPS port 443<instance> (instance 00 → `:44300`).
The e2e `s4Pull` scenario runs against a fake Gateway (`makeS4JournalService`).

## Subcontractor and Material report pages

Both pages are native tabs that mirror the Excel report's sheets (spec: `docs/port/native-report.md`; it
supersedes the removed Excel-clone view): SQL for the numbers, the app's own components, interactive. The
⤓ Excel export is unchanged and still built by `buildSubcontractWorkbook` / `buildMaterialWorkbook`; the
`SC_*` / `MAT_*` queries and the export tie to the same KPI (the e2e asserts it).
- **One stored query per sheet**: `SC_SHEET_*` / `MAT_SHEET_*` in `systemQueries.ts` / `materialQueries.ts`.
  Each takes the page's filters as optional params written `(:p IS NULL OR col = :p)`, so filtering is SQL;
  the page passes `null` for an unset filter.
- **Text keys carry a `~` prefix.** A key that is TEXT but looks numeric (a service code `020212`, a material
  number) must reach SQL as text, but the query runner's `coerce()` binds numeric-looking strings as numbers
  (and the `.0` rendering then breaks equality). The page sends `"~" + value` and the query strips it
  (`scParam()` in `systemQueries.ts`), so the value is never coerced.
- **Page shape**: `<KpiStrip>` from `SC_REPORT_KPI` / `MAT_KPI`, one `<ReportFilterBar>` above the tabs
  (search + dimension selects, chips, Clear; the page turns its values into the optional params),
  then `<SheetTabs>` with lazy content (a tab is fetched when first opened and again when a filter, the
  project or `dataVersion` changes). Month-by-column sheets use long-format SQL plus `<MonthPivot>`
  (measure toggle, To date column, group subtotals). Tables are `<DataTable>` with `defaultGroupBy` +
  `keepGroupOrder` for the sheet's own grouping (Type of works / family), `noSumColumns` for every
  rate, price, percentage and quantity column (their group / total rows must not add up), `hiddenColumns`
  for drill-down keys, `columnLabels`, `totalRow` and `compact` for small summaries.
- **Drill-down**: clicking a summary row (service, PO line, subcontractor, material) opens the underlying
  certificate / issue lines below it from `SC_SHEET_LINES` / `MAT_SHEET_LINES` filtered to that key.
- Material without MB51 loaded falls back to the CJI3 material postings page.

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

The menu is kept to the monthly routine (Home + Loaded files, Coding, Reports, Settings). The builder tools
(Analysis, Pivot builder, Query library, Schema diagram, Data lineage — the `Advanced` group) are hidden unless
Settings › Developer tools is switched on (`devTools` in `useApp()`, per computer). Sources nothing can be
loaded into yet (a SAP report in development, an offline form without a template) are notes on the Home map,
not cards. Cost types and Work packages are one **Coding** page (`Coding.tsx`, page id `coding`): tabs GL accounts
(`CostTypes part="allocate"`), Materials / Subcontract services / Other GLs (`PackageMapping tab=…`) and Lists (both
catalogues), with "Only what still needs coding" on by default. Links still say 'costtypes' / 'packages' /
'coding:<tab>' and go through `navigate()` in `App.tsx`.

**Actual cost register** (`Register.tsx`, page id `register_cost`, the monthly report): `v_actual_cost` by category and
row: the item, its source(s) and unit, **Cumulative to <cut-off month>** as the first figure column (`MonthPivot totalFirst`),
then one column per month (the cut-off month tinted); Amount or Quantity (quantity is per item — `noGroupTotals` leaves
category subtotals blank since units differ); each category in its cost type's own `dim_cost_type.color`; groups collapsed
first. Unit and source are taken once per row (CTE `u`), and an item row is keyed on code + name (a service code can carry
several texts), so the page and the workbook list the same rows. Rows (`:rows_by`) are the item — migration 027 added `item_code` / `item_name` to
`v_actual_cost` (CJI3 = GL, a subcontract PO without certificates = 'PO <no>', MB51 = material, CERT = service,
ORDER = 'Order <no>'), plus `quantity` / `unit` per line (CERT = `report_qty`) — or the work package or WBS. Queries `REG_KPI` / `REG_MONTHLY` / `REG_LINES` share `REG_BASE_SQL`;
the e2e asserts every view adds up to `v_actual_cost`. ⤓ Excel (`register:export` → `services/registerReport.ts`) writes
Per month (Unit, Qty to date, Cumulative, months; SUBTOTAL formulas) and Lines. It replaced Project dashboard, Actual cost (GL pivot) and the Cost
Report in the menu: those pages are in developer tools, and `navigate()` sends links to them to the register when the
tools are off. Next: a close checklist and a monthly pack export on Home.

Pages live in `src/renderer/src/pages/` and are wired in exactly two places in `App.tsx`:
the `PAGES` array (nav entry, glyph, subtitle) and the `page === '...'` switch in the
`content` div. Both need updating to add a page — there is no router.

`useApp()` (defined in `App.tsx`) is the only way a page reaches shared state: `projectKey`
/ `project` (the picker in the top bar), and `dataVersion` — bumped by `touch()` after a
successful import, which is how a page knows to re-run its queries without a manual
refresh. A page that fetches once in a plain `useEffect(() => ..., [])` will go stale after
the next import; depend on `[projectKey, dataVersion]` instead.

Home (`Home.tsx`, page id `home`, the start page) is the build workspace and the only place uploads start
(the separate Upload data page was removed). Its default **Map** view (`components/ArchMap.tsx`) draws the
actual-cost source architecture: CJI3 as the spine feeding each cost category, each category's detail
sources as cards (status, lines, date span) that accept a dropped file (`api.files.pathOf` →
`webUtils.getPathForFile`) or open the wizard via ↥. The wizard is `Upload.tsx` embedded with `preset`
(the step's `module` / `report_definition_id` from `BUILD_STATUS`) and `initialPath`. From a card the wizard fast-tracks: ↥ opens
the picker at once, then first sheet, detected data date (else today), saved mapping (else suggestion) and
staging run without stops, landing on the review — it stops early only at the step that needs the user
(an unmapped required column, a staging error) and never posts by itself. With no project (a new
database) Home queries project 0, so the map still shows every source as not loaded. The category layout
is presentation; the rule itself is `cost_source_rule` / `v_actual_cost`. App blocks window-level file drops
so a miss never navigates Electron to the file. The **Timeline** view is the Gantt below. Build steps from
`BUILD_STATUS` / `BUILD_CHECKS` and the report readiness cards from `REPORT_READINESS`. The step list is a
Gantt: one green bar per posted file from its first to last date on the project (`BUILD_TIMELINE`; a file
with no dates inside is a diamond at its data date), faint month lines, dashed gaps no file covers, and the
cut-off as a vertical line. A date key is converted only when present (`printf` over NULL gives
'0000-00-00'). It shows no
cost figures — the KPIs and charts are the **Project dashboard** (`Dashboard.tsx`, page id `dashboard`,
under Reports), which is also the `report_page` its readiness card opens.

Two established page shapes — reuse one rather than inventing a third:
- **Single-query explorer** (`Analysis.tsx`, `QueryLibrary.tsx`): pick one stored query,
  render it via chart/table/SQL tabs. This is what `query_library.viz_json` is for.
- **Assembled dashboard** (`Dashboard.tsx`, `SubcontractorAnalysis.tsx`,
  `MaterialAnalysis.tsx`): several stored queries fetched into one screen — a `<KpiStrip>`
  (renders every column of a single-row headline query generically, so a new KPI is a SQL
  change, not a component change), a couple of charts, a `<DataTable>` detail table. Reach
  for this shape for a new "insights + details" report. `SubcontractorAnalysis.tsx` and
  `MaterialAnalysis.tsx` go further: a shared `<ReportFilterBar>` and lazily-fetched
  `<SheetTabs>` that mirror a workbook's sheets (see "Subcontractor and Material report pages").

`Reports.tsx` is the one bespoke page (a collapsible cost-type/GL/WBS pivot with sortable
columns and a shared filter bar) — copy its patterns only when the data is genuinely
tree-shaped; a flat KPI+chart+table screen belongs in the assembled-dashboard shape above.

Chart components (`src/renderer/src/charts/`: `BarChart`, `StackedColumnChart`, `Treemap`, `LineChart`,
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
