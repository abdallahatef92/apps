# Port plan: Subcontract v2.6 + Material v1.2 report tools

Gap analyses: `docs/port/sc-gap.md`, `docs/port/material-gap.md` (item ids P1-x / P2-x below refer to them).

## User decisions (2026-10-10)

1. **Material actuals come from MB51 + ME2N**, even where CJI3 has no material cost. For a project with
   MB51 loaded, material actual cost = MB51 goods issues (`v_material_issue`, cut off by posting date);
   CJI3 lines with cost type MATERIAL are excluded from the *headline actual* for that project so nothing
   counts twice. A check reconciles MB51 vs CJI3 material. Projects without MB51 keep CJI3 material.
2. **Subcontract rules follow the tool** (sc-gap P1-9 / R1–R5): Normal only within max(1, 0.1%) of qty×rate;
   adjustment qty at the PO line's certified rate; certificate = PO + serial; normalised description key;
   undated / after-cut / unapproved lines are Pending. Update CLAUDE.md where it states the old rule.
3. **Report month = month of the project cut-off** (`project_cutoff`); no cut-off → latest month with
   counted data. Buckets: Opening, Previous (months before report month), This month, To date
   (= Opening + Previous + This month), Pending.
4. **Excel exports match the tools' workbooks**: SC export re-pointed to v2.6's sheet set; new Material
   export from v1.2. Both fed by the same stored queries/views as the pages.

## MNL and Cost element (user definition, 2026-10-10)

MNL = resource category: **MAT** Material, **SUB** Subcontract, **EQU** Equipment, **LAB** Labour, **OTHER** Other resources.
It is the app's cost type expressed as a code — no separate coding step:
- Store it as data: `dim_cost_type.mnl` (MATERIAL→MAT, SUBCONTRACT→SUB, EQUIPMENT→EQU, LABOR→LAB,
  everything else→OTHER; a user-added type defaults to OTHER and is editable in Cost types). Migration
  `023_mnl_codes.sql`; the earlier one-letter `mnl_code` from `022_mnl.sql` is kept unused.
- SC export: MNL = SUB for every service line. PKG and Cost element are left blank for the user to fill
  (their own catalogue codes, which the app does not store).
- Material export: MNL = MAT; PKG = the material's work package (`material_work_package`); Cost element is left blank for the user to fill (their own catalogue codes).

## Reference workbooks (from the user)

- `C:\Users\abdallah.atef\Desktop\ELAN_SC_Report_2026-08.xlsx` — real v2.6 tool output: the **target** for
  the SC Excel export (sheets Summary, Coding, Lists, _Codes, Service Summary, Service per Month,
  PO Register, PO per Month, Subcontractor Summary, Invoices Register, Checks, Changes, Data, Notes,
  hidden _Meta/_Cal/_Ref). Its Coding/Data sheets carry DIV, PKG, MNL and Cost element per service.
- `C:\Users\abdallah.atef\Desktop\C-DIST_service_report_2026-09-17.xlsx` — the app's current (older)
  export format, for comparison only.

## Scope

- SC: sc-gap P1-1…P1-9, P2-1 (At a glance cards), P2-5 (Excel), P2-6 (method card).
- Material: material-gap P1-1…P1-10, P2-1 (At a glance cards), P2-7 (fixtures).
- Deferred: SC P2-2/3/4/7, Material P2-2 (changes), P2-3 (manual per-material MNL/cost element pickers — MNL is now derived, see above),
  P2-4 (PO register page), P2-5, P2-6, P2-8.

## Headline actual with MB51 (`v_actual_cost`)

New view `v_actual_cost`: one row per counted cost line with a common column set
(`project_key, period_key, posting_date, cost_type, wbs_key, wbs_code, wbs_name, material_code,
vendor_code, vendor_name, amount, source` where source ∈ 'CJI3','MB51'): all `v_actual` rows except
MATERIAL rows of projects that have MB51 lines, UNION ALL `v_material_issue` rows (cost_type 'MATERIAL').
Headline queries switch to it: `KPI_PROJECT`, `FLOW_STATUS`, `S_CURVE`, `ACT_MONTHLY_TREND`,
`ACT_BY_COST_TYPE`, `COST_HEATMAP` (and `PKG_SUMMARY`'s MATERIAL part: package from
`material_work_package` by material_code). GL-level screens (Reports pivot, anomaly checks,
`UNIFIED_COST_REGISTER`) stay on CJI3 `v_actual` — MB51 has no GL; note it in their hints.

## Ownership / collision rules

- Migrations: `019_sc_port.sql` (SC data), `020_material_groups.sql` (group catalogue),
  `021_material_issue.sql` (MB51/ME2N/MATLIST + v_actual_cost). Each worker registers its own file in
  `MIGRATIONS` (`src/main/db/index.ts`), re-reading the file right before editing.
- Stored queries: SC in `src/main/db/systemQueries.ts` (as today). Material queries in a new
  `src/main/db/materialQueries.ts` exported and spread into the system list by one import line.
- Every worker re-reads a shared file (systemQueries.ts, ipc.ts, preload, styles.css, CLAUDE.md,
  importer.ts, targetFields.ts) right before each edit and keeps edits local.
- CLAUDE.md non-negotiables hold: aggregation in SQL, reporting views only (POSTED batches), every fact
  row has import_batch_id, staging before facts, colours via tokens, renderer has no Node/db.

## Waves

| # | Task | Tier / model | After |
|---|---|---|---|
| 1 | SC data layer (019) | careful / sonnet | — |
| 2 | Material data layer (021, v_actual_cost) | careful / sonnet | — |
| 3 | Material group catalogue (020) | light / haiku | — |
| 4 | SC report screens | medium / sonnet | 1 |
| 5 | Material report screens + coding tree | medium / sonnet | 2, 3 |
| 6 | SC Excel v2.6 | medium / sonnet | 4 |
| 7 | Material Excel v1.2 | medium / sonnet | 5 |
