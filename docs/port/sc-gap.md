# Subcontract Cost Report v2.6 (standalone HTML) vs the app: gap analysis

Source: `C:\Users\abdallah.atef\Desktop\SC REPORT 2\REPORT TOOL\Subcontract_Cost_Report_v2.6.html` (engine "SCEngine 2.6", UI at lines 252-387 and 2126-2543).
Target: `C:\Users\abdallah.atef\apps`. Read: CLAUDE.md, docs/flow-redesign.md, migrations 017/018, `SC_*` in `src/main/db/systemQueries.ts` (702-960, 1969-2288), `SubcontractorAnalysis.tsx`, `subcontractReport.ts`. The Excel workbook was compared at sheet-name level only, not cell by cell.

Abbreviations: TOW = "Type of Works for PO" (ZSCSRV1). Cert = certificate = PO + invoice serial.

---

## 0. Summary

The tool is **month-centric**: pick a report month (cut date defaults to its last day) and every figure is split into Previous / This month / To date / Pending, then compared with last month, last month's rates and last month's report. The app's `SC_*` queries are **all-time** (no month, no cut-off): the biggest structural gap.

Second: the tool's main dimension is **Type of Works** (from ZSCSRV1). `works_type` is stored in `fact_po_service_line` but no view or query reads it.

Third: no **rate analysis**, no **Invoices Register** (subcontractor x month matrix), no **At a glance** insight cards.

The data layer (line class, net rate, report qty, trade, buckets, PO match, snapshots, footer check) is already ported, with the rule differences in section 3.

---

## 1. Tool inventory

### 1.1 Inputs

| Slot | SAP report | Columns read (exact header text) | Notes |
|---|---|---|---|
| ZSCPRG01 (required) | certificate lines | Plnt, Profit Ctr*, Invoice Serial (new), Date, Pur. Doc., Account Number of Supplier (holds NAME), Supplier (holds CODE), Character 1 (approved = X), Flag (opening = X), DocumentNo*, Item, Number, Line, Gross Price, Service, Short Text 1, Tx, `نوع العقد` (contract type A1/A2), Current Quantity, Total Quantity*, Progress %*, VAT Current, SC Work Current Cost (amount), Entry Sh.*, Short Text*, WBS Element* (* optional) | Rows without Pur. Doc. are SAP subtotals; a "SUTH (14,807)" style row is the grand total (footer). |
| ZSCSRV1 (recommended) | PO service lines | Purchase Order, PO item, PO Service Code, PO Service UOM, PO Service Material Group (+Description), **Type of Works for PO**, Subcontractor (+Name), Plant, Service Short Text, PO Service Qty, PO Service Price, **PO Service Unlimited**, **PO item description** | Gives unit, service group, TOW per PO, PO title, PO qty per PO + service + description. |
| Last month's report (.xlsx made by the tool) | itself | `Coding` sheet (DIV, PKG, MNL, Cost element per Service + Description), `Lists` (code lists + TOW order), `Data` (history for Changes), `_Meta` | The tool keeps state in the workbook; the app keeps it in SQLite. |

Controls in "This month's load" panel: drop zone (files recognised from columns), 3 slots with status, **Report month** select (default newest closed month), cut-date note, checkbox **Roll earlier years into one "Previous years" block**, Build / Clear. The panel folds to a rail after build. Theme toggle. Top bar: `plant · month · cut date`, stale badge, **Download Excel report**.

### 1.2 Screens

| # | Screen / section | What it shows | Controls |
|---|---|---|---|
| A | **How the monthly loop works** (landing) | SVG diagram files > tool > live Excel > next month; "Each month" 4 steps; "The calculation in one line each" (10 rules, 1.4) | none |
| B | **Report overview** KPI strip | 5 cards: **Previous (last month)** = Opening + months before report month; **This month** with up/down % vs last month; **To date** (service rows, subcontractors); **Pending** (not approved / later); **Active subcontractors** (with cost in month, certificates) | none |
| C | **Cost per month** | Stacked column. x = bucket (Opening, months); stack = resource type by first letter of service code (S Subcontract, L Labour, P Plant, Other); negatives supported; current month highlighted with total label; tooltip = per type, Total, Cumulative, Active subcontractors. "Show as a table": Month, types, Total, Cumulative, Subcontractors | table toggle |
| D | **At a glance** (9 insight cards) | 1 This month vs last month (% and top-2 TOW up/down); 2 Where this month went (TOW mix bar, top 4 + Other); 3 Subcontractors (active, last month, top-3 share, new, stopped); 4 Certificates this month (count, average, largest, awaiting approval); 5 Rates this month vs previous (value effect, % on qty, rows dearer/cheaper/same/check, largest effect, since-start effect); 6 New work (Service+Description first certified this month); 7 Pending (not approved / after cut / no date, largest supplier); 8 PO quantities (rows over 100% / at 90-100% of PO qty, worst row); 9 To review (warn checks, changes since last report, coding left) | "go" buttons jump to a tab |
| E | **Details**: Top services this month | Top 10 by this-month amount: Service + PKG + description, Qty (+unit), Rate, **vs prev.** (rate change %, "same", "check"), Amount | none |
| F | **Details**: Cost by | Columns This month, To date, share bar, Total row | seg toggle **Type of works / DIV** |
| G | **Details**: Top subcontractors this month | Top 10: name (+code, PO count), Type of works, Certificates, This month, To date, Pending | none |
| H | **Details**: Coding meters | Fully coded % (rows + amount) and DIV / PKG / MNL / Cost element % each | none |
| I | **Invoices Register** tab | Matrix: rows = subcontractors (largest to-date first) + "All subcontractors" row; columns = Opening, [Previous years], each month, To date; cell = compact amount or certificate count; heat shading (not on Opening / Previous years); tooltip amount + certs; sticky headers. Note: "A certificate = PO + invoice serial, counted once. Approved and dated up to the cut date – Pending is not included." | seg **Amount / Certificates**; roll-years checkbox |
| J | **Checks** tab (+ badge) | Chips OK / Check / Info, count, amount, detail, expandable first 100 rows (1.5) | none |
| K | **Changes** tab (+ badge) | vs last report: "Months already reported" table (Last report / This report / Difference per month) and "Lines that changed" (Change, Month, Subcontractor, Service, Description, Last report, Now, Difference; first 300) | none |
| L | **How it works** tab | The 10 rules + Order / Building / Rebuild-by-hand notes | none |

### 1.3 Excel output (live; cut date in Summary!B4; SUMIFS on Data)

Summary (KPIs, cost and certificates per month, SAP-total tie-out, live checks = 0) · Coding (DIV/PKG/MNL/CE typed here) · Service Summary (qty, rate, amount, **rate analysis**) · Service per Month · PO Register · PO per Month · Subcontractor Summary · Invoices Register · Checks · Changes · Data (every line) · Lists · Notes · hidden `_Meta`, `_Codes`, `_Ref`, `_Cal`, `_Legacy`.

### 1.4 "The calculation in one line each" (tool's own words, shortened where marked "...")

1. **Clean.** "Rows with no PO in ZSCPRG01 are SAP subtotals and the grand total – dropped."
2. **WBS repeats.** "Same PO + serial + item + number + line → counted once." (SAP repeats the full amount on every WBS it is split over.)
3. **Zero lines.** "Lines with no amount are left out – SAP lists every PO line on each certificate."
4. **Net rate.** "Gross price, or Gross ÷ (1 + VAT) when the contract type is A2 (price includes VAT)."
5. **Qty.** "Normal line: SAP Current Quantity. Paid-% change, hold release, reversal or re-price: Amount ÷ the rate its PO line was certified at – so quantity always moves with the money."
6. **Month.** "Not approved, or dated after the cut date → Pending. Flag = X → Opening. Otherwise the month of the certificate date."
7. **Coding.** "DIV, PKG, MNL and Cost element per Service + Description (DIV is filled from the service code). Not coded yet → one 'Not coded' line ..., so totals still tie."
8. **Live Excel.** "pick another cut date on its Summary sheet (cell B4) and every sheet follows."
9. **Rates.** "... compares this month's rate with the previous rate (to last month), and the to-date rate with the start rate (the row's first month) – change, % and value (qty × change). Rates more than 3× apart show 'check'."
10. **Certificates.** "A certificate = PO + invoice serial, counted once."

Engine rules not in that list (from the code):
- Line type: **Zero** (no amount, no qty), **Qty only** (qty, no amount), **Normal** if `|amt - qty*net| <= max(1, 0.1% of |amt|)`, else **Adjustment**.
- Adjustment qty = `amt / PO-line certified rate` (sum amt / sum qty of that PO line's Normal lines); fallback own net rate.
- Pending reason: Not approved / No date / After cut date. Previous = Opening + buckets before the report month; To date = Previous + This month; Pending is never in To date.
- VAT rate per tax code is read from the data (`VAT Current / Amount`, most common value, lines > 100 only); fallback P0 0, P2 10%, P3 14%; unknown = 0 with a warning.
- Unit: ZSCSRV1 UOM (most common), else code suffix after "-", else Arabic unit words in the text.
- DIV auto-fill from service code chars 2-3 (S03xx = DIV 03; S01/S02/S34, L, P = INDIRECT). Suggestions for other fields when >= 60% of coded rows of the same service (or same description) agree.
- Coding key = Service + **normalised** description (strips Arabic diacritics, unifies alef/ta marbuta/ya forms, spacing around `- + * / ( )`, lower-case).
- Rate change counts only when both rates > 0 and within 1/3..3; "start rate" = rate in the row's first period with qty, over all approved dated lines regardless of cut date.
- PO qty compared only for limited PO lines (`PO Service Unlimited` blank): certified qty to date / PO qty; over = above 100.05%, near = 90-100.05%.
- Order everywhere: TOW (user order from Lists; new ones largest first) > service (largest within) > description.
- Month list: first month with cost up to the report month, no gaps.

### 1.5 Checks list (Checks tab)

SAP grand total tie (warn if diff >= 1) · WBS repeats removed (info, count + amount) · Same line number with different amounts (warn, rows) · Not approved > Pending (info, rows) · Dated after cut date > Pending (info) · No certificate date > Pending (warn, rows) · VAT rates used / unknown rate (warn) · Contract type not A1/A2 (warn, rows) · ZSCSRV1 not loaded / for another plant / matches · Every service has a unit (warn, rows) · Every line has a type of works (warn, PO rows) · Rows with a negative To date (warn, rows) · Paid-%, reversals, re-prices (info: count, this month, to date) · Lines left out: zero amount, qty-only (info) · Report total ties: Certified = To date + Pending · Coding checks: complete, new rows not in coding file, older coding format, new codes, no coding file.

---

## 2. App mapping

Legend: **Same** = rule and output match. **Partial** = exists, differences stated. **Missing**.

### 2.1 Screens and inputs

| Tool item | App location | Status | Exactly what differs |
|---|---|---|---|
| ZSCPRG01 input | SERVICE module, `fact_service_line` (migration 017), importer | **Partial** | Flags, tax, profit centre, package no, split_count, footer (`import_batch.control_total`) all captured. An undated line takes the batch period (`importer.ts:863`) instead of going Pending "No date". |
| ZSCSRV1 input | `PO_SERVICE` > `fact_po_service_line` / `v_po_service_line` | **Partial** | `works_type` captured but **no query or view reads it**. **Not captured:** `PO Service Unlimited`, `PO item description` (PO title), `Plant`. Material group captured, unused. |
| Last-month report as state | `service_line_snapshot` per posted batch | **Partial** | Snapshot has po, vendor, service, amount, flags, split only. No period/bucket, so month moves cannot be detected. Coding lives in `service_work_package`, not in a file. |
| Report month + cut date | `project_cutoff` (018), top bar | **Missing for SC** | `v_service_line` is explicitly not cut off (flow-redesign "Not cut off (yet)"). No `SC_*` query has a report month. |
| A. Loop diagram | none | Skip | App flow is Input > Coding > Reports. |
| B. KPI strip | `SC_REPORT_KPI` > `KpiStrip` | **Partial** | App: certified, approved, opening, pending, adjustments, VAT, subcontractors, POs, other-PC, WBS-split repeats. Tool: Previous, This month (+% vs last), To date, Pending, Active subs. App "approved" **excludes Opening**; tool To date **includes** it. |
| C. Cost per month | `SC_MONTH_BY_TRADE` > `StackedColumnChart` | **Partial** | App stacks by **trade** (top 7 + Other), approved months only, **no Opening bar, no cumulative, no active-subs tooltip, no table toggle**. Tool stacks **resource S/L/P/Other** (`resource_code` exists in the view, unused). |
| D1 This month vs last | none | **Missing** | needs report month |
| D2 Where month went | none | **Missing** | TOW mix; app has all-time trade only |
| D3 Subcontractors card | `SC_ACTIVE_SUBS_BY_MONTH` chart; top-3 banner from `SC_BY_SUPPLIER` | **Partial** | Missing: new this month, stopped, last-month count; top-3 share is all-time |
| D4 Certificates | `SC_BY_SUPPLIER.certificates` | **Partial** | App counts `DISTINCT invoice_no`; tool counts PO + serial (`invoice_serial` is captured, unused). No month scope, average, largest, awaiting-approval |
| D5 Rates | none | **Missing** | no previous-rate / start-rate logic in SQL |
| D6 New work | none | **Missing** | first-certified month per service + text |
| D7 Pending | `SC_REPORT_KPI.pending_amount` | **Partial** | single total; no split by reason, no supplier |
| D8 PO quantities | `SC_QTY_RECONCILIATION` | **Partial** | App compares qty **received** (ZSCSRV1) with qty certified per PO line; `pct_received` = received / contract qty. Tool: certified-to-date / PO qty, flags above 100% and 90-100%, skips "Unlimited" lines (not loaded), PO qty summed per PO + service + normalised text |
| D9 To review | failed-check count in tab label | **Partial** | no summary card; changes net and coding left not shown together |
| E. Top services | `SC_TOP_SERVICES` (top 15, all-time) | **Partial** | Qty, avg rate (Normal lines at report_qty), amount, % total, unit (`SC_UNIT_SQL` = same as tool). Missing: month scope, **vs prev. rate**, package. 15 vs 10 |
| F. Cost by TOW / DIV | `SC_TRADE_SUMMARY` | **Partial** | Trade = service code chars 2-3, not DIV/TOW. Columns opening/approved/pending/total/%/subs; no This month / To date. **TOW grouping missing** |
| G. Top subcontractors | `SC_BY_SUPPLIER` (bar) | **Partial** | POs, certs, lines, net, VAT, gross, %. Missing: This month, To date, Pending, main TOW |
| H. Coding meters | Work packages page (`PKG_SUMMARY`), `service_work_package` | **Partial** | One dimension only (work package) keyed on exact `(service_code, service_text)` per project. No MNL, no Cost element per service. Key not normalised. No auto-fill from service code, no suggestions |
| I. Invoices Register | none (`Heatmap` chart exists; `SC_INVOICE_RECONCILIATION` is per certificate vs actuals) | **Missing** | no supplier x month matrix, no Amount/Certificates toggle, no Previous-years roll-up, no "All" row |
| J. Checks | `SC_CHECKS` + `DataTable flagColumn` | **Partial** | see 2.2 |
| K. Changes | `SC_CHANGES_SUMMARY`, `SC_CHANGES`, `SC_LOAD_HISTORY` | **Partial** | see 2.3 (app adds a load-history chart) |
| L. How it works | `.hint` paragraphs | **Partial** | rules scattered, no method page |
| Excel report | `sc:exportReport` > `subcontractWorkbook.ts` + `subcontractReport.ts` | **Partial (different workbook)** | App sheets: Dashboard, Service Monthly, Service Coding, Changes, Detail, PO Register, By Supplier, Subcontractor x Trade, Subcontractors over time, Qty Reconciliation, Coding, Notes. Not in app vs v2.6: Summary with live cut date, Service Summary rate analysis, PO per Month, Invoices Register, Checks sheet, Lists / TOW order |

### 2.2 Rules and checks

| Rule / check | App | Status |
|---|---|---|
| Drop no-PO rows, grand-total footer | `detail_key_fields` skip; footer kept as `control_total` | Same |
| WBS repeats counted once | `SPLIT_COLLAPSE_MODULES`, `split_count`; check "Repeated on WBS splits" | Same |
| "Same line number, different amounts" | key collision falls back to plain inserts, import-screen note only; not in `SC_CHECKS` | Partial |
| Zero-amount lines left out | `Qty only` kept in view, report_qty 0; no "lines left out" info row | Partial |
| Net rate A2 = gross / (1+VAT) | `net_rate` via static `dim_tax_code` (P0/P2/P3) | Partial: tool reads the rate from data and warns on unknown tax code; app silently uses 0 |
| Normal vs Adjustment | `line_class` | **Different**: app is Adjustment only if qty = 0 or `abs(qty) <= 0.01` with amount != qty x rate; a paid-80% line stays Normal and is reported at amount / net rate (`is_equiv_qty`). Tool: any line with amount != qty x net rate beyond tolerance is Adjustment |
| Qty of an adjustment | app: Adjustment qty = 0; equivalent qty = amount / **own** net rate | **Different**: tool = amount / **rate its PO line was certified at** |
| Bucket Pending / Opening / month | `bucket` | Partial: **no After-cut-date, no No-date pending**; month = `period_key` (batch period if undated) |
| Previous / This month / To date | none | Missing |
| Trade from service code | `trade`, `dim_sc_trade`, `trade_label` | Same data (tool shows DIV/TOW instead; trade is an app extra) |
| Resource S/L/P | `resource_code` column | Data present, unused in `SC_*` |
| Unit resolution | `SC_UNIT_SQL` | Same |
| Other profit centre | `is_other_pc` | App extra |
| PO line match tiers | `v_service_line_po_match` | App extra |
| Footer check footer - splits - lines = 0; "not checked" when no footer | `SC_CHECKS` rows 1-4 | Same |
| Report total ties (certified = to date + pending) | row 5 compares view total with latest upload | Partial (different identity) |
| Not approved / after cut / no date rows | none | Missing |
| Contract type not A1/A2 | none | Missing |
| ZSCSRV1 plant vs ZSCPRG01 plant | none (Plant not captured on PO side) | Missing |
| Every service has a unit | `SC_CHECKS` row 11 | Same |
| Every line has a type of works | none | Missing |
| Rows with negative To date | none | Missing |
| Adjustments info (this month / to date) | counts only (rows 6-8) | Partial |
| Certificate lines with no PO service line | `SC_CHECKS` row 10 | App extra |
| Coding complete / new rows | Work packages coverage | Partial |
| Rates (3x guard, start rate, value) | none | Missing |
| Order TOW > service > description | `ORDER BY amount DESC` | Missing |

### 2.3 Changes comparison

| Aspect | Tool | App (`SC_CHANGES_SQL`) | Status |
|---|---|---|---|
| Baseline | the last report loaded | the two newest POSTED / SUPERSEDED batches' snapshots | Partial (same idea, no file needed) |
| Scope | only lines touching a month the last report **already showed** | all lines | Different: app "New" includes lines of the current, not-yet-reported month |
| Types | New line in a reported month, Amount changed, Approved after it was reported, Moved to Pending, Moved to a later month, Moved to another month, Removed from SAP | New, Amount changed, Approved since last load, Removed | Partial: 3 "Moved" types missing |
| Newly approved amount | counted at full amount | full amount | Same |
| Month table (Last report / This report / Difference per month) | yes | no | Missing |
| Removed lines | "Removed from SAP" | 'Removed'; line stays in `fact_service_line` | Same (documented) |

---

## 3. Rule differences that change numbers (resolve first)

| # | Topic | Tool | App | Impact |
|---|---|---|---|---|
| R1 | Cut date and Pending | After cut date and No date go to Pending | not applied | To-date totals differ by the held-back lines |
| R2 | Opening in To date | To date = Opening + months | "approved" excludes Opening | KPI "approved" differs from tool To date |
| R3 | Adjustment definition and qty | see 2.2 | different | qty and avg rate in Top services, adjustment counts / amount |
| R4 | Certificate identity | PO + serial | distinct `invoice_no` | certificate counts |
| R5 | Undated line | Pending "No date" | batch period | cost in the wrong month |
| R6 | Description normalisation | `normText` in coding and grouping key | raw `service_text` | duplicate service rows, split coding |

---

## 4. Prioritised gap list

Conventions for every item: aggregation in SQL as a stored query in `systemQueries.ts` with `viz_json` beside it; read only `v_service_line` / `v_po_service_line` / `v_service_line_po_match` (never `fact_*`); colours from tokens (`--s1..s8` fixed slots, sequential ramp for magnitude, `--good/--warning/--bad` for status only); schema change = numbered migration registered in `MIGRATIONS`; page shape = assembled dashboard (`KpiStrip` + chart + `DataTable` inside `SheetTabs`, as `SubcontractorAnalysis.tsx`).

### P1: must-have for parity

| ID | Build | Where | Reuse / pattern | Cut-off |
|---|---|---|---|---|
| P1-1 | **Cut-off and report month inside `v_service_line`.** Migration `019_sc_cutoff.sql` rebuilds `v_service_line` (keep every current column including `report_name`) joining `project_cutoff`; add `pend_reason` ('Not approved' / 'No date' / 'After cut date') and make all three `bucket = 'PENDING'`. Stop the batch-period fallback for undated SERVICE lines (`importer.ts:863`, or derive from `invoice_date_key` in the view). Report month = month of the cut-off, else latest approved period; expose as a column or small view. Add `v_service_line_all` (no cut) for status counts. Update the "Not cut off" notes in flow-redesign.md. | Data layer + Reports (Subcontractors) | Mirrors how 018 cuts `v_posting` and keeps `v_posting_all` | **Yes: this is the cut-off** |
| P1-2 | **Previous / This month / To date / Pending KPIs.** Extend `SC_REPORT_KPI` (keep old fields): previous (Opening + months before report month), this month (+ last month, % change), to date, pending split (not approved / after cut / no date), active subs this month, certificates this month, subs to date. | Reports | `KpiStrip` (SQL-only change); document R2 in the hint | Yes |
| P1-3 | **Type of Works.** Add `tow` column to `v_service_line` (first non-empty `works_type` of the PO from `v_po_service_line`; '(no type of works)' otherwise). New table `dim_tow_order(project_key, tow, sort_order)` (migration) so a user order survives; default order = amount desc. Use TOW in Cost by, Where month went, top-supplier column, PO register order. | Reports; order editor in Coding | list with up/down like `GroupedPackageTable` rows, or numeric field | Via the view |
| P1-4 | **Cost per month as in the tool.** `SC_MONTH_BY_RESOURCE`: Opening first, then months <= report month; series = `resource_code` S/L/P/Other; total, cumulative, active subs. `StackedColumnChart` + table toggle (`DataTable`). Keep trade chart as the second chart. Negatives supported. | Reports > Overview | `StackedColumnChart`, series `--s1..s4` | Yes |
| P1-5 | **Month-scoped Details.** `SC_TOP_SERVICES_MONTH` (top 10 by this-month amount: qty, rate, vs previous rate %, amount); `SC_COST_BY_TOW` and `SC_COST_BY_CODING` (This month / To date / share) with a TOW / work-package toggle; `SC_TOP_SUBS_MONTH` (certificates, this month, to date, pending, main TOW). Certificate = `po_no \|\| '\|' \|\| invoice_serial`. | Reports | `DataTable` in `SheetTabs`; toggle = two stored queries; share bar via `BarChart` | Yes |
| P1-6 | **Rate analysis in SQL** per Service + Description row: previous rate, this-month rate, to-date rate, start rate (rate in the row's first period with qty, ignoring cut-off), change, % change, value = qty x change; if either rate <= 0 or ratio outside 1/3..3 return 'check' and exclude from totals. Needs R3 qty. Feeds D5, E and the Excel Service Summary. | Reports > new "Rates" tab | `DataTable` with `signColumns`, `flagColumn` for check | Yes (start rate not cut) |
| P1-7 | **Invoices Register.** `SC_INVOICES_REGISTER` in long format (vendor code, name, main TOW, bucket, amount, certificates) with a to-date column and an "All" row; param `:roll_years` for the Previous-years block. Tab with Amount / Certificates toggle. Render with `Heatmap` (sequential ramp, zero neutral, Opening and Previous years unshaded) or a `DataTable` crosstab; sticky first column. | Reports > new tab | `Heatmap` takes `(row, col, value)`; extend for sticky header + total row | Yes |
| P1-8 | **Checks parity.** Extend `SC_CHECKS` with count / amount for: not approved, after cut date, no date, contract type not A1/A2, missing TOW (needs P1-3), negative To-date rows, VAT rate source (data / standard / unknown), same-line-different-amount conflicts, zero / qty-only left out, certified = to date + pending. Row lists from a companion query `SC_CHECK_ROWS(check_code)`. | Reports > Checks | `DataTable flagColumn`; expand rows from second query | Yes |
| P1-9 | **Align line rules (R3, R4).** `line_class` Normal only when `abs(amt - qty*net) <= max(1, 0.1% of abs(amt))`; Adjustment `report_qty` = amount / PO-line certified rate (window over `po_no, item_no, package_no, line_no` on Normal lines), fallback own net rate; certificates by PO + serial. **Decision needed**: the app deliberately uses a different rule today (CLAUDE.md: a Normal line off qty x rate is reported at amount / net rate). Add a fixture with an 80%-paid line, a hold release and a re-price in `tests/makeFixtures.ts`, assert numbers. | Data layer (migration 019) | `check:*` script pattern | n/a |

### P2: nice to have

| ID | Build | Where | Reuse | Cut-off |
|---|---|---|---|---|
| P2-1 | **At a glance cards** (9). A small `InsightCard` component reading one-row stored queries (`SC_INSIGHT_MOM`, `_MIX`, `_SUBS`, `_CERTS`, `_RATES`, `_NEWWORK`, `_PENDING`, `_POQTY`, `_REVIEW`); text composed from numeric columns, no arithmetic in the UI. New work = service + text whose first non-pending month is the report month. New / stopped subs = first bucket is report month / cost last month and none now. | Reports > Overview, above Details | `KpiStrip` tile style; `--warning` for flagged cards | Yes |
| P2-2 | **PO quantities, tool rule.** Capture `PO Service Unlimited`, `PO item description`, `Plant` into `fact_po_service_line` (migration + `targetFields.ts` synonyms). `SC_PO_QTY` = certified-to-date qty / PO qty per PO + service + normalised text; flag above 100% and 90-100%. Keep the received-vs-certified reconciliation. Plant mismatch check. | Input (columns), Reports > Qty tab | extend `SC_QTY_RECONCILIATION` | To date up to cut-off |
| P2-3 | **Changes parity.** Add `period_key`, `is_opening` (and the load's `cutoff_date`) to `service_line_snapshot`; "reported" = buckets up to the previous load's report month; add types Moved to Pending / later month / another month; restrict "New" to reported months; add `SC_CHANGES_MONTHS` (Last report / This report / Difference per month). | Reports > Changes | `SC_CHANGES_SQL` fragment | Evaluate per load with its own cut-off |
| P2-4 | **Service coding model.** Normalise the key (stored `service_text_norm` using the tool's `normText`), auto-fill work package from service-code chars 2-3 (015's CSI packages already match DIV 03...33), suggestions at >= 60% agreement, coded-% meters by amount. MNL / Cost element only if the user needs them (cost type via cost element may already cover MNL). | Coding > Work packages (Subcontractors tab) | `GroupedPackageTable`, `CoverageMeter`, `service_work_package` | No (coding is not time-scoped) |
| P2-5 | **Excel additions** in `subcontractReport.ts` / `subcontractWorkbook.ts`: Invoices Register, Checks, Service Summary rate columns, PO per Month, cut-date cell driving SUMIFS. Source rows from the new stored queries so page and workbook agree. | Reports (export button) | existing adapter | Project cut-off |
| P2-6 | **Method card**: one collapsible "How the figures are calculated" (the 10 rules, 1.4, in app wording). | Reports | static component | n/a |
| P2-7 | **Roll earlier years** option (`:roll_years`) on month series and the register. | Reports | query param | Yes |

### P3: skip

| Item | Reason |
|---|---|
| Loop diagram, drop zone, Build button, stale badge, fold rail, theme button | App has Upload wizard, Data register, global theme, `touch()` refresh |
| Last-month report as input (coding + history in workbook, `_Meta`, `_History`, `_Lines`, `_Legacy`, v1 migration) | State lives in SQLite (`service_work_package`, snapshots) |
| Hidden `_Cal`, `_Codes`, `_Ref` sheets, workbook Lists editing | Not needed with a database; TOW order lives in `dim_tow_order` |
| Golden-angle TOW hue function | Breaks the app palette rule (8 fixed categorical slots, never cycled); use slots and fold the rest into "Other" |

---

## 5. Suggested order

1. P1-1 and the P1-9 decision (R1-R5), with fixtures and `db:check` coverage.
2. P1-3 (TOW), then P1-2, P1-5, P1-4 (all need report month and TOW).
3. P1-6 rates, P1-7 register, P1-8 checks.
4. P2 in order: P2-3, P2-2, P2-1, P2-4, P2-5, P2-6, P2-7.

## 6. Open questions

- R3 / P1-9: adopt the tool's Adjustment and PO-line-rate rule, or keep the app's "equivalent qty at own net rate"? Qty, average rate and the rate analysis will not match the tool unless adopted.
- Report month source: month of `project_cutoff` (tool: report month = month of cut date) or an explicit selector. Recommendation: cut-off month, no extra selector.
- MNL and Cost element per service: needed, or is work package + cost type enough?
- The app workbook is a port of a different (earlier) standalone tool than v2.6. Re-point it at v2.6's sheet set (P2-5) or leave it?
