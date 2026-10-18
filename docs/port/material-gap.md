# Material Cost Report v1.2 - gap analysis against the app

Source: `Desktop\Materail Report\Material_Cost_Report_v1.2.html` (engine L459-1308, Excel writer L1309-2213, UI L2214-2640).
Sample inputs for fixtures exist in `Desktop\Materail Report\DATA\` (MB51 / ME2N / MB52 for DIST, SUTH, TRAZ; MM60 SUTH) and two finished reports in `Reports\`.

## 0. Headline findings

1. **Different SAP source.** The tool does not read CJI3. It costs material from **MB51** (material-document movements = goods issues to the project), enriches with **ME2N** (PO lines) and optionally **MB52 / MM60** (material master: group, type). The app has no MB51, no ME2N, no movement type and no material group on a material (`material_group` exists only on PO *service* lines). The app's Materials report is `v_actual WHERE cost_type='MATERIAL'` (CJI3 GL postings that carry a Material column).
2. **Family > division > group is NOT the work-package concept.** It is SAP's material-group tree (MATKL): a read-only classification of *what a material is*, with about 1,000 SAP names baked into the tool. The app's work packages (16 CSI divisions + INDIRECT) are a *user coding* of where cost belongs. The tool's equivalent of a work package is its **PKG** column. The tree is a **new dimension** for the app; it is compatible and complementary (a material has both a group and a package) and is the natural grouping axis for the Coding > Materials tab.
3. **The tool's coding is three typed columns** (PKG, MNL, Cost element) per material. The app has one coding field per material (work package). PKG = same concept as `material_work_package`. MNL (Material/Subcontract/Equipment/Labour/Other) overlaps the app's cost type but works per material, not per posting. Cost element is typed in the tool; the app takes the real posted GL from CJI3. See 2.2.
4. **The cut-off already exists in the app** (`project_cutoff`, applied inside `v_posting`, docs/flow-redesign.md). The tool's cut date (`Summary!B4`, name `CutDate`) behaves identically: posted after the cut date => Pending, else month of the posting date. A new MB51 fact must be cut off the same way, but `v_posting` only covers `fact_actual`, so the new view needs its own cut-off join.
5. **The tool is the sibling of the Subcontract tool**: same live-workbook template (`CutDate` named cell, SUMIFS on a Data sheet, Coding sheet with KPI band, Lists, Checks, Changes, Notes, `_Meta`). The app's `subcontractWorkbook.ts` (580 lines, ExcelJS port, `@ts-nocheck`) + `subcontractReport.ts` (typed adapter) + `sc:exportReport` in `ipc.ts` is the template to copy. The material workbook has **no native charts** (conditional formats only), so the `jszip` chart injection is not needed.

## 1. Tool inventory

### 1.1 Inputs

| Input | Detected by columns | Used for | Key columns |
|---|---|---|---|
| **MB51** (required) | `Material Document` + `Movement Type` | Every cost line | Material, Plant, Storage Location, Movement Type (+Text), Material Document, Material Doc.Item, Material Doc. Year, Posting Date, Material Description, Qty in unit of entry, Amt.in Loc.Cur., Unit of Entry, Entry Date, Supplier (= subcontractor on Z21), WBS Element, Order, Reservation, User Name, Document Header Text, Text, Valuation Type |
| **ME2N** (recommended) | `Purchasing Document` + `Material Group` | Material group, unit, suppliers, PO prices, PO Register, purchasing KPIs | Purchasing Document, Item, Document Date, Supplier/Supplying Plant, Plant, Material, Material Group, Short Text, Order Unit, Deletion Indicator, Order Quantity, Price Unit, Net Price, Net Order Value, Still to be delivered (qty/value), Still to be invoiced (qty/val.) |
| **Material list** (optional): MB52 / MM60 / master | `Material` + `Material Group` + `Material Type` | Group for materials on no PO line; material type | Material, Material Description, Material Type, Material Group, Base Unit |
| **Group descriptions** (optional) | `Material Group Description` | Update the built-in name catalogue | |
| **Last report** (the tool's own xlsx) | `_Meta` + `Data` sheets | Brings the **coding** (Coding + Lists sheets), history (Data: Line ID/Period/Amount) for Changes, learned groups/types | |
| **Report alone** | same | Rebuilds the whole report without SAP files (MB51 from Data, ME2N from `_Ref`, movements from `_Mvt`) | |

**Wizard controls:** drop zone (files recognised by columns, also dropped anywhere on the page); four slots with per-file meta (plant, rows, issues, month range) and an "other project - not used" plant check; **Report month** select (default = newest closed month with cost; cut date = last day of month); checkbox **Roll earlier years into one "Previous years" block** (only when older years exist; saved in the report); **Build report**; **Clear**; fold/unfold of the load panel; light/dark theme.

### 1.2 The method - "The calculation in one line each" (quoted)

| Rule | Text |
|---|---|
| Clean | "Rows with no Material in MB51 are SAP's total row - dropped (its amount is kept to check the file against)." |
| Issues | "Material cost = the issues to the project: 221/222 GI/RE for project, Z21/Z22 GI to subcontractors with deduction (recoverable), 551-556 scrap. Receipts, transfers, issues to orders or cost centres ... are not project cost - listed in Checks." (engine also accepts 281/282 for a network) |
| Zero lines | "Issues with no value are left out - owner-supplied material (valuation type CUSTOMER) and scrap at no price." |
| Sign | "SAP signs an issue negative and a return positive: here an issue is a positive cost. Qty and amount both turn." |
| Rate | "Amount / Qty - the price the material was issued at (its moving average price in SAP)." |
| Month | "Posted after the cut date -> Pending. Otherwise the month of the posting date." |
| Group tree | "Every material sits on the SAP material-group tree: family (M Materials, P Plant & tools, SP Spare parts...) > division (M03 Concrete) > group (M030201 Steel Bars) > material, with SAP's names. Every sheet follows that order and folds on those three levels." |
| Coding | "PKG, MNL and Cost element, typed per material on the Excel Coding sheet - its description and material number decide its code. A KPI band on top shows what is still to code (count and amount); the Lists sheet shows it by family > division > group. Not coded yet -> one "Not coded" line, so totals still tie." |
| Live Excel | "pick another cut date on its Summary sheet (cell B4) and every sheet follows (SUMIFS on the Data sheet)." |
| Rates | "Material Summary compares this month's issue rate with the previous rate (to last month), the to-date rate with the start rate (the material's first month), and the to-date rate with the weighted PO price in ME2N. Rates more than 3x apart show "check": a unit mix-up, not a price change." |

Other engine rules: a repeated document line (doc + year + item) is counted once; issue type P / S / X = Project / To subcontractors / Scrap; Pending = after cut date **or** no posting date; Previous = months before the report month, To date = Previous + This month (Pending never counts); a material's weight = |net amount|; group source order = ME2N, else material list, else last report.

### 1.3 Group tree and coding model

- **Family** = leading letters of the SAP material group (M Materials, P Plant & tools, SP Spare parts/oils/fuel, SM Safety, SH Site housing, CS Consumables, OS Office, IT, G General hardware, A Assets, SR Survey spares, SC Scrap, S Services, MTEX Vehicle maintenance, L Labour, OVM Overhead, WST Wastage), in a fixed order.
- **Division** = family + two digits when the catalogue has it (M03 Concrete, P04); families without two-digit divisions show "no SAP division".
- **Group** = the full group code (M030201 Steel Bars). Intermediate catalogue prefixes are skipped; one-digit nodes (M0 "Complex Resources") are dropped.
- **Where it comes from:** ME2N `Material Group` (most frequent per material), else the material list, else the last report. Names come from a catalogue of about 1,000 rows embedded in the tool (updatable by dropping a description file). Reference data, never typed.
- **Coding** (typed in Excel, one row per material): **PKG**, **MNL** (seed list MAT/SUB/EQU/LAB/OTHER), **Cost element**. Code lists live on the Lists sheet; a new typed code joins the list (case-insensitive canonicalisation). Coded = all three typed; row status Coded / Partly coded / Not coded. Carried to next month inside the report file; `New` flag for materials not in the last coding.

### 1.4 Screens

| # | Screen / section | What it shows | Controls | Rule behind it |
|---|---|---|---|---|
| 1 | **This month's load** (left panel, "Step 1") | Slots MB51 / ME2N / Material list / Last report with per-file meta; messages; report month; cut-date hint | drop/choose files, remove (x) per slot, Report month, Roll checkbox, Build, Clear, fold | file detection by columns; plant mismatch warns and ignores the file |
| 2 | **How the monthly loop works** (landing) | SVG flow MB51 + ME2N + last report -> tool -> live Excel -> code in Excel -> next month; "Each month" 4 bullets; the method list | none | static |
| 3 | **Top bar** | `{plant} - {Mon-yy} - cut {date}`; subline: materials, SAP groups, families, divisions, To date, coding % complete; "stale" notice; **Download Excel report** | download | stale after file/month change until Build |
| 4 | **KPI strip** (Report overview) | 5 cards: Previous (last month) / This month (+/- % vs last month) / To date / Pending (after cut date) / Materials issued (+ issue documents) | none | Previous = months before; Pending = after cut or no date |
| 5 | **Cost per month** | Stacked column chart per month; stack = issue type (Project, To subcontractors, Scrap; only types present, Project always); negatives stack below the axis; current month value label; hover tip (each type, Total, Cumulative, Materials issued); colour slots s1-s3; "Show as a table" (Month, 3 types, Total, Cumulative, Materials, Documents) | hover, table toggle | sum by bucket and issue type, running cumulative |
| 6 | **At a glance** (up to 10 insight cards) | (a) This month vs last: % change, top 2 up / down divisions. (b) Where this month went: top-4 divisions + Other, share bar. (c) Coding - still to do: count, amount, top-2 divisions with most left, missing PKG/MNL/CE counts, link to Coding status. (d) Issue documents: count, average, largest doc, Z21 recoverable. (e) Rates this month vs previous: value effect, dearer / cheaper / same / to-check, largest effect, since-start effect. (f) New materials this month. (g) Pending: after cut / no date, largest. (h) Issue rate vs PO price (above +10% / below -10%). (i) Purchasing - ME2N: still to deliver, open > 90 days, delivered-not-invoiced, delivered-never-issued, Committed = to date + open. (j) To review: warn checks, changes net, coding % | "go" buttons to Coding status / Checks | `insights()` in the engine; a rate change counts only when both rates > 0 and within 3x, else "check" |
| 7 | **Details > Top materials this month** | Top 10 by this-month amount: material, group, description, Qty + unit, Rate, "vs prev." (red up, green down, same, check), Amount | none | rate = amount / qty; vs prev = this-month rate vs rate to last month |
| 8 | **Details > Cost by** | Table with in-row bar: This month, To date, share of To date; total row | segmented Family / Division / PKG / MNL | grouped from the pivots |
| 9 | **Still to code - the largest materials** | Top 10 not-fully-coded by To date: material, description, group label, Missing (which of PKG/MNL/CE), This month, To date; footer count + amount | none | not every field typed |
| 10 | **Coding - typed per material** | 4 meters: Fully coded (% of amount, N of M materials) + PKG, MNL, Cost element (% of amount, N missing / complete) | none | amount-weighted share |
| 11 | **Coding status tab** | Tree table Family > Division (> Group): Materials, Coded, To code, To date, Not fully coded, % of all, coded bar; total row | Divisions / + Groups toggle | coded = all 3 typed |
| 12 | **Checks tab** (badge = warn count) | Chips OK / Check / Info with count, amount, detail, expandable 100-row list. Checks: MB51 rows = SAP total row; duplicate document lines; movement types not in rules (warn); movements that are not material cost (info, grouped); posted after cut date; lines without posting date; open PO lines > 90 days; ME2N loaded and matches plant; material list effect; every material has a group; one unit per material; negative To date; issued to subcontractors (Z21) per SAP supplier; lines left out (no amount, owner-supplied); report total ties (issued = To date + Pending); coding complete; New materials; coding migrated; new codes added | expand details | informational - "none of them changes a figure" |
| 13 | **Changes tab** (badge = rows) | "Months already reported (last report: Mon-yy)": Month / Last report / This report / Difference + total; "Lines that changed" (first 300): Change, Month, WBS, Material, Description, Last report, Now, Difference | none | line diff on Line ID (doc\|year\|item) vs previous Data sheet. Types: New line in a reported month, Amount changed, Pending in last report counted now, Moved to Pending / later month / another month, Removed from SAP |
| 14 | **How it works tab** | The method rules + Reference data, PO Register, Building, Rebuild by hand | none | static (also on the Excel Notes sheet) |

### 1.5 Output: the Excel workbook (`{plant}_Material_Report_{yyyy-mm}.xlsx`)

Live: one input `Summary!B4` (name `CutDate`, list validation from hidden `_Cal`). `Data` has a Period-key formula on CutDate; report sheets are SUMIFS over named ranges (`D_Amt`, `D_Qty`, `D_PK`, `D_ID`, `D_Fam`, `D_Div`, `D_Grp`, `D_Typ`, `D_WBS`, `D_MK`, `D_Doc`, `D_MatN`). Every formula is written with a cached result. Row grouping folds family / division.

| Sheet | Content |
|---|---|
| **Summary** | KPI cards (Previous, This month, To date, ...); 1 Cost per month by issue type with cumulative; coding tables per PKG / MNL / Cost element (live); 5 Cost by family > division > group (foldable); 6 Purchasing (ME2N) per PO type (not live); 7 From the MB51 total to this report (reconciliation) and live checks that must show 0; print page break |
| **Coding** | Header on row 4 under a KPI band (rows, coded, to code, missing per field, coded share of To date, open amount). Columns: Family, Division, Material group, Material, Description, Unit, **PKG, MNL, Cost element** (yellow input cells, list validation), Status, Qty to date, Rate, To date, This month, New, POs, Suppliers, First / Last issued, key columns, ID. Conditional formats, autofilter |
| **Lists** | Code lists (PKG, MNL, Cost element: code + name), PO type names, coding-by-tree table (Family/Division/Group with To code, Not fully coded, bar) |
| **Material Summary** | Per material grouped by division: Qty / Rate / Amount for Previous, This month, To date, Pending; rate analysis (vs previous, vs start rate, vs weighted PO price, value effect) |
| **Material per Month** | Month by month Qty / Rate / Amount per material; optional "Previous years" roll |
| **PO Register** | ME2N as exported, PO > lines; per material ordered / delivered / open qty, PO value, open value, to invoice, lowest / last / weighted price, spread, delivered - issued, issue rate, vs weighted PO, Issued to date, Issued + open; line Flag (Blocked, Open > 90 days, Price > 20% above lowest, To invoice); PO type = first two digits of the PO number |
| **Stores Transfers** | Stock-transport PO lines from own stores (no value) |
| **Checks**, **Changes** | As 1.4 #12 and #13 (as made, not live) |
| **Data** | Every issue line: Family, Division, Group, Material, Description, PKG/MNL/CE (looked up live), Period (formula), Posting date, WBS, Issue type, Material doc., Qty, Rate, Amount, Pending reason, movement fields, SAP qty/amount (original signs), unit, entry date, subcontractor, reservation, user, text, header text, valuation type, storage location, order, material type, key columns incl. Line ID |
| **Notes** | Method + reconciliation block (Summary FINAL CONTROL points at it) |
| `_Meta`, `_Cal`, `_Mvt`, `_Ref`, `_Codes` (hidden) | Version, plant, report month, cut date, file names, MB51 control figures; cut-date list; non-cost movements summed; ME2N lines; code lists |

No native Excel charts.

## 2. App mapping

### 2.1 Inputs and data model

| Tool item | App location | Status |
|---|---|---|
| MB51 import (goods-issue movements) | none (`grep MB51` in `src/` finds nothing). Closest: CJI3 `material_code` -> `fact_actual.material_key`, `dim_material` (014) | **Missing** (different source; CJI3 has no movement type, reservation, valuation type, storage location, entry date) |
| Movement-type rules (in: 221/222/Z21/Z22/551-556; out: receipts, transfers, ...) | none | **Missing** |
| Issue type P / S / X | none (`cost_type` only) | **Missing** |
| ME2N (material PO lines) | none. `PO_SERVICE` / `fact_po_service_line` (017) is the service-PO analogue (ZSCSRV1), different columns | **Missing** |
| Material list (MB52 / MM60) | none | **Missing** |
| Material group on a material | `dim_material` has only code + name; `material_group` exists only on `fact_po_service_line` / `v_service_line` | **Missing** |
| SAP group-name catalogue and family order | none | **Missing** |
| Last-report round trip (coding + history in xlsx) | DB is the history; coding in `material_work_package`; `service_line_snapshot` exists for SERVICE only | **Partial** by design; no material-line snapshot |
| Duplicate line / total-row checks | line identity upsert (`NATURAL_KEY`), `import_batch.control_total` (017) exist generally | **Partial** (MB51 key = doc + year + item) |
| Plant mismatch warning | wizard project selection | **Partial** (needs plant -> project) |
| Cut date | `project_cutoff` + `v_posting` (018) | **Same concept**; covers `fact_actual` views only |
| Report month select / "Previous years" roll | cut-off month plays the report month; no roll | **Partial** |

### 2.2 Coding

| Tool concept | App equivalent | Verdict |
|---|---|---|
| **PKG** per material | `material_work_package (project_key, material_code -> work_package)`; Work packages page > Materials tab (`PackageMapping.tsx`); `dim_work_package` seeded with CSI + INDIRECT | **Same concept**; app is ahead (project-scoped, bulk picker, tri-state groups, Excel round trip `workPackages:exportMaterialMapping` / `importMaterialMapping`). Tool's PKG list is free codes; app's is a catalogue |
| **MNL** per material (MAT/SUB/EQU/LAB/OTHER) | `cost_type` resolved per posting in `v_posting` via `cost_type_rule` / `dim_cost_type` | **Different mechanism**: no per-material resource code in the app. MB51 issues are MATERIAL by nature, so value is unclear. Business meaning beyond the 5-value list is not stated in the tool: ask the user |
| **Cost element** per material | `dim_cost_element` from the posted GL (CJI3) | **Not needed on CJI3**; needed only if MB51 (no GL) becomes the source and the user still wants it |
| **Family > division > group** | none. Nearest: Materials tab "group by code prefix (first two digits)"; package `group_label` (Civil/Arch/MEP) | **New dimension.** Not equal to work packages. Complementary: tree = what the material is (SAP), package = where cost belongs (user). The code-prefix grouping is a stand-in only; real SAP numbering differs from MATKL |
| Status Coded / Partly / Not coded; KPI band; `New` flag | Materials tab: unallocated count and %, `CoverageMeter`, warning styling | **Partial**: one field => two states; no "new since last coding" |
| Coding status tree and "Still to code - largest" | Materials tab group headers (N unallocated, % of total, meter); sort by Amount reorders groups | **Partial**: groups are prefix/package, not family > division > group; no separate top-10 list |
| Code lists page | Work packages > Packages tab | **Same** |
| Excel round trip of coding | `exportMaterialMapping` / `importMaterialMapping` | **Same** (one field) |

### 2.3 Reports (HTML screens)

| Tool screen | App | Status |
|---|---|---|
| Load panel | `Upload.tsx` generic wizard (staging, caption mapping) | **Partial**: no MB51 / ME2N report definitions; no multi-file auto-recognise slots |
| Landing "monthly loop" | Home step cards (`Dashboard.tsx`) | **Same intent** |
| KPI strip | `KPI_MATERIAL` + `KpiStrip`: material_amount, postings, gl_count, vendor_count, actual_total, pct_of_actual | **Partial**: no Previous / This month / Pending / Materials issued / documents |
| Cost per month stacked by issue type | `MATERIAL_MONTHLY_TREND` -> `LineChart` area, one series + cumulative column | **Partial**: not stacked, no issue types, no table toggle |
| At a glance cards | none | **Missing** (all 10). Pieces: `MATERIAL_RATE_OUTLIERS`, `MATERIAL_RETURNS` |
| Top materials this month | `MATERIAL_BY_MATERIAL` BarChart (amount, all periods) | **Partial**: no month filter, no qty / rate / rate vs previous |
| Cost by Family / Division / PKG / MNL | by Material, GL, WBS, Vendor (`BarChart` / `Treemap`) | **Partial**: no group tree; PKG split exists app-wide in `PKG_SUMMARY`, not on this page; no MNL |
| Still to code - largest | Materials tab (Coding) only | **Partial** |
| Coding meters | Materials tab meter; `FLOW_STATUS.coded_pct` (all cost) | **Partial** |
| Coding status tree | none | **Missing** |
| Checks tab | none for material | **Missing** |
| Changes tab | `SC_LOAD_HISTORY` / `SC_CHANGES` over `service_line_snapshot` (SERVICE only) | **Missing** for material (pattern reusable) |
| How it works tab | page hint texts | **Partial** |
| Rate analysis (vs previous, vs start, vs PO price, 3x check) | `MATERIAL_RATE_OUTLIERS` (line > 5x its GL average) | **Different/Partial** |
| Rate Outliers / Returns / Detail tabs; spend by GL / WBS / vendor | `MaterialAnalysis.tsx` | **App-only extras** (keep) |
| Purchasing KPIs, PO Register, Stores Transfers | none | **Missing** |
| Z21 recoverable material | none | **Missing** |

### 2.4 Excel output

| Tool output | App | Status |
|---|---|---|
| Live workbook (`CutDate`, SUMIFS, named ranges) | `sc:exportReport` -> `subcontractWorkbook.ts` + `subcontractReport.ts` (same template, sibling tool); generic `exportResult()` | **Missing for material**; SC port is the template |
| All sheets of 1.5 | none | **Missing** |
| Report-alone rebuild from xlsx | n/a (DB is the source) | **Skip** |

## 3. Gap list (prioritised)

Flow: Input = Upload; Coding = Work packages page; Reports = Materials page / Excel export. Cut-off column: Y = reads through `project_cutoff`.

**Decision first (blocks P1-1..P1-4):** load MB51 (+ ME2N) as new sources, or stay on CJI3? The tool's figures cannot be reproduced from CJI3 (no movement type, no group, no PO price). Recommendation: add MB51/ME2N as new modules and reconcile to CJI3 material cost.

### P1 - parity must-have

| # | Build | Flow | Reuse | Cut-off | Schema |
|---|---|---|---|---|---|
| P1-1 | **MB51 source**: report definition `MATISSUE` (module row), `fact_material_issue` (project, material_key, plant, movement_type/text, doc + year + item as `line_uid` NATURAL_KEY, posting_date, entry_date, qty and amount in SAP sign, unit, wbs_key, supplier code, order, reservation, valuation_type, storage_location, texts, import_batch_id); view `v_material_issue` (POSTED only; keeps issue movements, derives `issue_type` P/S/X, flips sign to cost, drops zero-amount lines, month bucket) and `v_material_issue_all`; `material_movement_rule` table (mvt pattern, kind ISSUE/OUTSIDE, issue_type, group label) seeded from the tool's `ISSUE` / `OUTSIDE` lists (data, not CHECK, like `cost_type_rule`) | Input | Staging pipeline, `NATURAL_KEY` + `FACT_TABLE` in `importer.ts`, `targetFields.ts` synonyms (MB51 captions), SERVICE as structural example; SAP total row -> `import_batch.control_total` (already done for SERVICE) | Y: join `project_cutoff` as `v_posting` does; the `_all` view gives the Pending figure | `019_material_issue.sql`, register in `MIGRATIONS` |
| P1-2 | **Material group + SAP group tree**: `dim_material` += `material_group`, `material_type`, `base_unit`, `group_source`; `dim_material_group (code PK, name, family, division, sort_order)` seeded from the tool's ~1,000-row catalogue with family/division resolved at seed time using the tool's `treeOf` / `divOf` / `realDiv` rules; family order table (17 families). Group resolution order: ME2N, material list, previously known | Input (data) / Coding (display) | 015 seeding style; importer auto-vivify as `dim_vendor` / `dim_material` | n/a | same or `020_material_group.sql` |
| P1-3 | **ME2N + Material list sources**: `MATPO` module -> `fact_po_material_line` / `v_po_material_line` (PO + item key; qty, price unit, net price, net value, open qty/value, to-invoice, deletion flag; PUR vs STO kind in the view); `MATLIST` module only updates `dim_material` group/type/unit. Weighted PO price per material as a view column / stored query | Input | `PO_SERVICE` / `v_po_service_line` and `v_service_line_po_match` (017) | PO age computed at the cut-off; PO values as exported (the tool treats them as not live) | `020`/`021` migration |
| P1-4 | **KPI strip + month stack**: stored queries `MAT_KPI` (Previous, This month, To date, Pending, Materials issued, documents, % vs last month) and `MAT_MONTH_BY_TYPE` (month x issue type, cumulative as a column, negatives allowed) | Reports | `SC_REPORT_KPI` + `KpiStrip`; `SC_MONTH_BY_TRADE` + `StackedColumnChart`; `SheetTabs` as in `SubcontractorAnalysis.tsx` | Y via `v_material_issue` | none |
| P1-5 | **Group-tree grouping in Coding > Materials**: add a `group tree` dimension (family / division / group) to the existing `groupBy1` / `groupBy2` selector; join `dim_material_group` in `loadMaterialPackageCombinations` (`ipc.ts`); keep prefix and package options | Coding | `buildMaterialGroups()` / `buildGenericGroups()`, `groupKey` / `groupKeyLabel` props, `CoverageMeter`, sticky `.sel-bar` | Y (amounts from `v_actual` today; `v_material_issue` if MB51 is the base) | none beyond P1-2 |
| P1-6 | **Coding status tree report** (tab): Family > Division (> Group) with Materials, Coded, To code, To date, Not fully coded, % of all, coded bar. Stored query `MAT_COD_TREE`; coded = row in `material_work_package` for the project | Reports (link from Coding) | `PKG_SUMMARY` coded logic; `DataTable` grouping; `SheetTabs` | Y | none |
| P1-7 | **Materials Checks tab** `MAT_CHECKS` (SQL): control total vs staged rows ("not checked" when no footer, as `SC_CHECKS`); duplicate doc lines; movement types not in rules (warn) and known outside movements (info, grouped); after-cut-date and no-date lines; materials without a group; more than one unit per material; negative To date; issued to subcontractors (Z21) per supplier; zero-value lines left out (incl. owner-supplied); report ties (issued = To date + Pending); plus "MB51 vs CJI3 material cost" reconciliation | Reports | `SC_CHECKS` | Y | none |
| P1-8 | **Top materials this month** (Qty, Rate, rate vs previous, Amount) and **Cost by** switch (Family / Division / PKG) with share bar | Reports | `SC_TOP_SERVICES`, `DataTable` + `signColumns`, `BarChart` | Y | none |
| P1-9 | **Rate analysis in SQL** `MAT_RATES` per material: rate this month vs previous, to-date vs start rate (first month with qty), value = qty x change, 3x "check" rule, to-date vs weighted PO price (+/-10%) | Reports | `MATERIAL_RATE_OUTLIERS` window-function pattern | Y | none |
| P1-10 | **Material Excel report** `material:exportReport` -> `src/main/services/materialWorkbook.ts` (port of the tool's writer, `@ts-nocheck` kept) + `materialReport.ts` (typed adapter over `v_material_issue`, `v_po_material_line`, `material_work_package`, `dim_work_package`). Sheets per 1.5; hidden `_Meta` / `_Cal`; `_Ref` / `_Mvt` only as far as needed for the sheets (drop the round-trip-only parts) | Reports | `sc:exportReport` handler, `subcontractWorkbook.ts` (named ranges, SUMIFS, `CutDate`, cached results), `subcontractReport.ts`; no chart injection | `project_cutoff` written to `Summary!B4`; workbook live after that | none |

### P2 - nice to have

| # | Build | Flow | Reuse | Cut-off | Schema |
|---|---|---|---|---|---|
| P2-1 | **At a glance** cards (month vs last with top 2 up / down divisions, where the month went, new materials, pending, issue documents, rates, to review): one stored query per card returning one row, rendered by a small generic card component in the `KpiStrip` idiom | Reports | assembled-dashboard shape | Y | none |
| P2-2 | **Changes tab for material**: `material_issue_snapshot` per posted MATISSUE batch + `MAT_LOAD_HISTORY` / `MAT_CHANGES` diff on `line_uid` (New line in a reported month, Amount changed, Pending -> counted, Moved to month, Removed) | Reports | `service_line_snapshot`, `SC_CHANGES_SQL` fragment | "reported months" = buckets up to the last load's month | new snapshot table |
| P2-3 | **Per-material MNL and Cost element** coding: `material_coding_extra (project_key, material_code, mnl, cost_element)`, two pickers on the Materials tab and in the Excel mapping round trip. Confirm with the user first | Coding | `material_work_package` shape | n/a | new table |
| P2-4 | **Purchasing + PO Register page**: ordered / delivered / open, values, to-invoice, lowest / last / weighted price, spread, PO type (first two digits), status (Open / Partly delivered / Closed / Blocked / To invoice), age at cut-off, Flag (Blocked, Open > 90 days, Price > 20% above lowest, To invoice), Committed = to date + open, delivered-never-issued; stored queries `MAT_PO_REGISTER`, `MAT_PO_KPI`; `po_type_name (project_key, type, name)` | Reports | `v_po_material_line`, DataTable group-by | age uses cut-off | `po_type_name` |
| P2-5 | **Z21 "issued to subcontractors - to recover"** card and check per SAP supplier code (join `dim_vendor` where codes match) | Reports | vendor dimension | Y | none |
| P2-6 | "Previous years" roll option on the Material per Month export sheet only | Reports (export) | writer option | cut-off | none |
| P2-7 | **Fixtures and check script**: MB51 / ME2N shaped fixtures in `tests/makeFixtures.ts` with the real traps (SAP total row, receipts and transfers mixed in, Z21, owner-supplied zero lines, duplicate doc line, PO deletion indicator, STO supplying plant); assert numbers; `npm run check:matissue`. Real sample data in the tool's `DATA\` folder | Tests | existing `check:*` pattern | | |
| P2-8 | Group-name refresh by importing a "Material Group Description" file | Input | Settings cost-type manager pattern | n/a | none |

### P3 - skip

| Item | Why |
|---|---|
| Report-alone rebuild; `_Meta/_Ref/_Mvt` round trip; v1.0 / v1.1 / Rev02 coding migrations | DB is the history and the coding store |
| "Last report" slot, stale banner, load-panel fold | Replaced by the wizard + `dataVersion` refresh |
| Theme toggle, SVG loop diagram | App has its own |
| Golden-angle HSL colours per division | App colours come from validated palette tokens (CLAUDE.md Charts): categorical slots in fixed order, top-7 + "Other" as `SC_MONTH_BY_TRADE` does |
| Native Excel charts | The material workbook has none |
| Rate Outliers / Returns / Detail / WBS / Vendor tabs | App-only; keep as they are |

## 4. Notes and risks

- **Colours**: tool stacks use `--s1..--s3` for Project / To subcontractors / Scrap. In the app use categorical slots in fixed order, never the status set (`--bad` / `--good`) for series; "vs prev." red/green maps to the signed/diverging tokens with null and "check" neutral.
- **Aggregation in SQL**: every figure above (cards, rate effects, coding tree, month stack) is a stored query in `systemQueries.ts`. The tool's tree logic (`treeOf`, `divOf`) runs at seed/ingest time into `dim_material_group`, not at render time.
- **Reporting views read POSTED only and through the cut-off**: `v_material_issue` follows `v_posting_all` / `v_posting`.
- **No double counting**: goods issues to a WBS post to project cost in CO, so MB51 is a sub-ledger of CJI3 material cost, the same relationship as `fact_service_line` to a PO. Reconcile against `v_actual` MATERIAL, never add. Consider a Detail Substitution into `UNIFIED_COST_REGISTER` only if a shared key exists (material document number vs `fact_actual.document_no` / `reference_no`); decide before building.
- **Coding source of truth** stays `material_work_package` (project-scoped); never write the tree into `dim_wbs.package`.
- **Migration number**: next free is 019 (`MIGRATIONS` in `src/main/db/index.ts` ends at `018_cutoff`, whose file is untracked in git; confirm it is committed first).
- **Open questions for the user**: (1) meaning and downstream use of MNL and the typed Cost element; (2) does MB51 replace or only reconcile CJI3 material cost; (3) is plant to project 1:1 (the tool keys everything by plant).
