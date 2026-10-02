# Subcontract Cost Report tool

**Subcontractor Report · Version 1.01 · A.Atef** – the signature lives in `engine.js` (`TOOL`); the page footer, the
workbook properties and every printed report page read it from there. Bump `TOOL.version` (and `package.json`) on a release.

A single offline HTML page. The user drops this month's SAP **ZSCPRG01** (certificates) and **ZSCSRV1**
(PO service lines), optionally last month's report and the work package master, picks the **report month**,
and downloads the Excel report. Nothing is uploaded; the libraries are embedded in the page.

| File | Role |
| --- | --- |
| `engine.js` | Reads the exports, classifies lines, builds the workbook (ExcelJS) and post-processes the XML (JSZip). Pure logic – runs in the page and in Node. |
| `coding_ui.js` | Work package coding page: views, period filter, bulk coding, list editor. |
| `page.html` | Page shell and on-screen overview. |
| `build_standalone.py` | Turns `page.html` + `engine.js` + `coding_ui.js` + the libraries into the one-file tool (list editor, Save tool, light/dark switch). |

## Report rules (Rev08)

- **Report month → cut date.** The user picks a month; the cut date is its last day, computed in UTC
  (never the PC's local time, so 31-Aug stays in August east of UTC).
- **The certificate Date decides the month.** A line dated after the cut date, or not approved, is **Pending**:
  shown in its own block, never in Total (Detail → *Pending reason*).
- **Include in this report** (Detail, drop-down on after-cut lines): picking *Include* takes the line out of Pending
  into its month. Service Monthly has a block for every month in the data – after-cut months are red and fill only with
  included lines – and Service Quarterly, DIV Monthly, By Supplier and the Dashboard follow live.
- **Late lines** are flagged, never moved: *Added to a reported month* / *Approved after the month was reported*
  (Detail → *Reported-month flag*), from last month's report.
- **Service Monthly** and **Service Quarterly** are flat tables (no merged cells, no header or blank rows between data):
  row 1 TOTAL (SUBTOTAL), row 2 check against Detail (✔ or the difference), row 3 year, row 4 month / quarter,
  row 5 column names. Identity (11) → Opening → Qty / Rate / Amount per period → Total → Pending → reference columns.
  Service Monthly and Service Quarterly figures are live SUMIFS on Detail; row 2 re-adds every block from Detail.
  DIV / Package / MNL / Cost element / Unit are live lookups on Service Coding on both.
  **Trade** (after Unit) is the trade name from the service code, a live lookup on Coding → trades.
- **Per-service totals** (Service Coding → Total amount) are values; Dashboard → Final control checks them against Detail.
- **Cost Statement** (3rd tab): pick any month in B3 – This month | Previous | Change | Change % | YTD | ITD | Pending, by DIV
  and by service. Rows are dynamic arrays (SORT / UNIQUE / FILTER over Detail → DIV (live) / Statement key), so new services,
  new DIVs and codes changed on Service Coding appear without a rebuild – needs Microsoft 365 or Excel 2021. The engine
  marks the anchors as dynamic (cm="1" + xl/metadata.xml) and writes cached results for the report month;
  `tests/stmtcheck.py` checks them against the recalculated Detail.
- **Rolling Monthly** (after Service Monthly): the same rows at a fixed width however long the project runs –
  Opening | B/F prior years | Jan … Dec of the report year | YTD | ITD (to date) | Pending, all live SUMIFS on Detail.
  In January the previous year folds into B/F by itself; checks: ITD = Opening + B/F + YTD, ITD + Pending = Detail.
- **PO Register**: one row per PO, its services underneath (grouped, − / + folds them), each service with its DIV,
  Package, MNL and Cost element live from Service Coding; a check row confirms the services add up to their POs.
- **Type of works** (ZSCSRV1 "Type of Works for PO", one per PO) shows on Service Monthly, Service Quarterly and the PO Register.
- **Coding dimensions**: **DIV** (CSI division) is automatic from the service code (S0303 → DIV 03; S01/S02/S34, labour L
  and plant P → INDIRECT); a DIV typed for a service overrides it and only overrides are stored. **Package** is the team's
  own work package list (starts empty), **MNL** and **Cost Element** as before. Older masters and reports migrate on load:
  a DIV in the old Package column becomes automatic (or an override when it differs), S03-style codes become their DIV,
  any other name becomes a team Package.
- **DIV Monthly** sums Service Monthly by DIV (live); the Dashboard's cost table reads it. The Dashboard tile *Cost with a
  package* is the share with a team Package.
- **Lists** sheet (after Service Coding): the DIV, Package and MNL lists, which feed drop-downs on Service Coding. Rows
  added there, and codes typed in Service Coding that no list has, join the tool's lists when the report is loaded.
- **Opening a report on its own**: a report rebuilds without the SAP files – Detail holds every ZSCPRG01 line (WBS splits
  repeated, the SAP grand total from Notes as the footer), the hidden `_Serv` sheet keeps ZSCSRV1 and `_LinesPrev` the
  previous load's lines, so Changes and late flags come out as they did. Older reports open with warnings.
- **Work package master**: sheets DIV (division list), Packages (team list), MNL, Cost Elements, Service Mapping (DIV,
  Package, MNL, Cost Element), Removed (codes deleted in the tool – a newer tool list keeps master rows added in Excel but
  never brings a deleted code back).
- **Tool screen**: the **Overview** tab is a dashboard – total to the cut date (opening / approved months / pending),
  the report month vs the month before, a status list that jumps to the right tab, cost by trade per month, the report
  month's top subcontractors, work packages (unallocated hatched) and the top 10 subcontractors with their excluded
  invoices flagged; the older tiles and tables sit under *More detail*. The **Invoices** tab shows every invoice as a
  chip (✓ in the report, ✕ not approved, ◷ after the cut date) by subcontractor / PO and month, with status tiles that
  filter, a status-by-month chart, the excluded list, search, and each invoice's lines on click. It follows the report
  month; Include picks made later in Excel are not visible to it.
- **Invoice Matrix** (2nd tab): one cell pair (invoice no. + amount) per invoice – an invoice is PO + Invoice Serial, and all
  its lines share one date and one approval – by subcontractor / PO and month. Colours are conditional formats on Detail:
  red = not approved, grey = after the cut date and not picked as Include, green = in this report. Each rule has its own
  priority and red / grey stop the green one (Excel needs both). Under each month: all invoices, in this report,
  excluded, and ✔ checks against Detail and Service Monthly; below, the list of every excluded invoice with a live status.
- **Monthly activity** (Dashboard, page 2): lines, approved cost, not approved, late lines per month, and for months
  the last report showed, *change = late lines* ✔ or the unexplained amount.

## Build and test

```bash
npm install
npm run build                      # -> dist/Subcontract_Cost_Report.html
SUBCON_PROG=<zscprog01 traz.xlsx> SUBCON_SERV=<zscsrv1 traz.xlsx> npm test
python3 tests/recalc.py <report.xlsx>        # LibreOffice recalculation: every check cell and Notes reconciliation
python3 tests/ooxml_order.py <report.xlsx>   # element order Excel requires
```

The tests assert the TRAZ numbers (SAP grand total 73,923,142.32, pending and after-cut amounts, late lines)
under two time zones and, when LibreOffice is installed, recalculate the report and require every check cell ✔. Real SAP extracts and generated reports are never committed (`*.xlsx` is ignored).
