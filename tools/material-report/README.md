# Material Cost Report

A standalone, offline HTML tool. It is the materials companion to the Subcontract Cost Report.
Each month you load three SAP exports, plus last month's report:

| Export | What it answers | Key |
|---|---|---|
| **ME2N** | What was ordered, from whom, at what price, and what is still open. It also gives each material its **material group** | PO + item |
| **MB51** | What physically moved, and where it went | material doc + year + item |
| **CJI3** | What the project paid. Only goods issues are counted (document type **WA**) | CO doc + posting row + year |

From these the page builds the Excel report: Dashboard, **Material Monthly**, Package Monthly, Materials, Price, Material Coding, Changes, Checks and Load history, plus the source sheets. The summary sheets are live formulas over *Cost Detail* and *Material Coding*. If you change a package code in Excel, the dashboard updates.

## How the numbers are made

- **Cost is CJI3 WA only.** SAP subtotal rows (blank document number) are skipped. The detail is tied to the grand total printed in the file, and lines with other document types are listed in Checks rather than counted.
- **Every cost line is tied to one MB51 movement.** The match uses the reference document number, reference fiscal year and the *second* "Posting Row" column. That column is the material document item; the first one is the CO posting row.
  - On the DIST extracts, all 5,254 lines match.
  - Material, value, WBS and quantity agree on every one of them.
- **Movements are classified** (see `CLASSES` / `MVT` in `engine.js`, and the *Movement Rules* sheet):
  - 101/102/122 → received from vendor. If the text says transit, or the PO is a stock transport order (the ME2N supplier is a plant / storage location), they count as received from stores instead. Account-assigned and asset receipts are not stock.
  - Z52 → owner supplied.
  - 221/222 → issued to project.
  - Z21/Z22 → issued to subcontractors (recoverable).
  - 261/262 → issued to orders, which is outside project cost.
  - 551 → scrap.
  - 351/352 and 601/602 → transferred out.
  - 541/542 → subcontractor stock.
  - 309/311/7xx → adjustments.
  - Anything else → Other, and it is flagged.
- **Stock balance** is the signed sum of the stock classes. It is only as complete as the MB51 date range.
- **Price:**
  - PO unit price = net price ÷ price unit, from purchase lines that are not deleted.
  - Issue price = CJI3 cost ÷ quantity issued to the project and to subcontractors.
- **Coding** is one Package / MNL / Cost element per material, using the same catalogue as the subcontract report.
  - The material group suggests a package: M03… → DIV 03, M0302… → DIV 0302, M26… → DIV 26, SM/SP/CS/OS… → INDIRECT.
  - Suggestions count only once you accept them.
  - Codes are kept in the browser and written into the report's *Material Coding* sheet. Loading that report next month brings them back, together with load history and a *Changes* comparison.

## Report period and cut-off

**Posting Date decides the month; Created on decides the report.** In the CJI3 file, Document Date, Value Date, Period and Fiscal Year all repeat the Posting Date and add nothing. *Created on* is the day SAP recorded the line, and it cannot be backdated.

After the three files load, the page asks for the **report month** and a **cut-off date**. It is a whole day: any line Created on that date or before counts. Build stays disabled until both are set.

**Suggested cut-off.** The tool suggests the day posting into the report month stopped. That is the latest Created on date among lines posted in that month or earlier, looking at most 10 days past the month end.
- On the DIST history this gives 1 Mar, 5 Apr, 5 May, 7 Jun, 5 Jul, 1 Aug and 1 Sep.
- Stragglers entered later than that become late postings next month.
- If the file doesn't reach the next month yet (an early export), it suggests the file's last Created on date and warns that postings may still come.
- You can always override the date.

**The four boxes.** Every CJI3 line is marked on *Cost Detail* (column **Cut-off status**) and in the material detail on the page:

| | Created on ≤ cut-off | Created on > cut-off |
|---|---|---|
| **Posted in the report month or earlier** | In report (or *Late posting* into a closed month) | Pending – entered after cut-off |
| **Posted after the report month** | Pending – next month, already entered | Pending – next month |

The period box shows these counts before you build.

**Closed months stay closed.** Each report stores its report month and cut-off in *Load history*. Next month's report reads them back, so every month already reported comes out exactly as it was, and a Checks item proves it. A line posted into a closed month is counted in the first open month and marked *Late posting*. Re-building a month that was already reported replaces that report and leaves earlier months alone.

**Timestamps.** A cost line takes the entry stamp of its MB51 movement. The two are one save, so quantity and cost fall on the same side of the cut-off.

**Opening roll-up.** *Roll into Opening* sums all months before a chosen month into the Opening block.

## Monthly exports: a window, not the whole history

The report carries every CJI3 line and MB51 movement it has seen, in two hidden sheets (`_CJI3`, `_MB51`) that use SAP's own column names. So after the first report, SAP only has to export a **posting-date window**.

| Export | Posting date from | Posting date to |
|---|---|---|
| **CJI3** and **MB51**, first report | project start | open |
| **CJI3** and **MB51**, every month after | **the 1st of the last reported month** (e.g. 01-Aug for the September report) | open |
| **ME2N** | no date filter | – |

**How the merge works.**
- The tool merges the window with the carried lines on SAP's line key: CO document + posting row + year, and material document + item + year for MB51.
- A line in both is counted once, and the export's version wins if SAP changed it.
- A carried line whose posting date falls inside the window but is missing from the export is kept, and reported in Checks. That usually means a different selection (WBS / plant) was used.

**Guards.**
- An export that starts after the last reported month blocks the build, with the date to export from.
- The printed-total check runs on the export itself.

**Tested on DIST.** September built from the one-month window (1,261 CJI3 lines) plus the August report is identical to September built from the full export (5,315 lines). That covers every month, every Material Monthly row and every stock balance.

## Material Monthly

This is the main sheet, and the block you copy into your cost report each month with Paste Special → Values. It is one flat table: one header row, no merged cells, and no header or blank rows between the data.

**Column layout, shared with Service Monthly from Rev08:**

`Identity (11)` → `Opening (3)` → `month 1 … n (Qty / Rate / Amount)` → `Total (4)` → `Pending (3, not in Total)` → hidden reference

- The identity columns are Row ID (hidden), CSI, MNL, Cost element, Material, Description, Material group, Last vendor code, Last vendor name, Line type and Unit.
- Opening sits in columns L–N, so the first month is always in column O.
- Each month's Qty and Rate fold under the **+** above its Amount.

**Rows** are one per material × line type:
- Project (221/222)
- To subcontractors (Z21/Z22, recoverable)
- Scrap (551)

Rows are sorted CSI → group → material → line type on every build. Each keeps a permanent Row ID (hidden `_Rows` sheet).

**Formulas.**
- CSI, MNL and Cost element are live lookups from *Material Coding*. Re-coding changes the row where it stands; nothing needs regrouping.
- Qty and Amount are SUMIFS on *Cost Detail* by Row ID and **Report bucket**.
- The TOTAL row (follows the filter) and a tie-out check against CJI3 cost to the cut-off sit above the header.

**Package Monthly** sums Material Monthly by CSI and month, so it is right whatever the row order.

## Build and test

```bash
cd tools/material-report
npm install
npm test                  # fixture tests (assert the numbers)
MCR_REAL=/path/to/exports npm test   # also reconcile real ME2N / MB51 / CJI3 files
npm run build             # → dist/Material_Cost_Report_Rev02.html (≈1.9 MB, works offline)
```

`engine.js` is pure logic and runs in Node and in the page. `app.js` is the page. `style.css` is the Rev07 stylesheet plus a few additions. `build.mjs` inlines SheetJS, ExcelJS, Chart.js and JSZip from `node_modules` into one file.
