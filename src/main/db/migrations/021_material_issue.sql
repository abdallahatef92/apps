-- =============================================================================
-- Material cost from SAP material documents (MB51), PO lines (ME2N) and the
-- material list (MB52 / MM60). docs/port/PLAN.md decision 1, docs/port/
-- material-gap.md P1-1, P1-2 (material columns), P1-3.
--
--   MATISSUE  MB51   goods-issue movements   -> fact_material_issue / v_material_issue
--   MATPO     ME2N   material PO lines       -> fact_po_material_line / v_po_material_line
--   MATLIST   MM60   material master list    -> updates dim_material only
--
-- Goods issues to a WBS post to project cost in CO, so MB51 is a sub-ledger of
-- CJI3 material cost. It is never added to it: v_actual_cost (end of file)
-- swaps CJI3 MATERIAL rows for MB51 issues, per project, wherever MB51 is loaded.
--
-- The movement-type rules are the Material Cost Report v1.2 tool's own (its
-- ISSUE / OUTSIDE tables), held as data in material_movement_rule:
--   ISSUE   221 222 281 282 -> P  Project   (GI / RE for project; 281/282 network)
--           Z21 Z22         -> S  To subcontractors (GI with deduction, recoverable)
--           551..556        -> X  Scrap
--   OUTSIDE (not project cost; listed for information, anything else is "unknown")
--           101 102 103 104 105 106 122 123 124 125 161 162   receipts, returns to vendor
--           301..306 309..316 351 352 641..644                transfers
--           601 602 651..654                                  deliveries
--           261 262 orders · 201 202 cost centres · 241 242 291 292 assets/other
--           541..544 subcontractor stock · 561..566 initial stock entry
--           701 702 707 708 711 712 717 718 inventory differences
--           Z5x owner-supplied stock · Z8x scrap taken back from the project
-- "SAP signs an issue negative and a return positive: here an issue is a
-- positive cost" - the views expose amount / quantity as cost (sign flipped)
-- and sap_amount / sap_quantity as loaded. "Issues with no value are left out"
-- (owner-supplied valuation type CUSTOMER, scrap at no price): amount = 0 lines
-- stay in the fact table and in v_material_movement, not in the issue views.
-- =============================================================================

INSERT INTO module_type (code, name, description, sort_order) VALUES
  ('MATISSUE', 'Material issues (MB51)', 'SAP material-document movements; goods issues to the project are material cost', 60),
  ('MATPO',    'Material PO lines (ME2N)', 'Purchase order lines for materials: quantities, prices, open and to-invoice', 61),
  ('MATLIST',  'Material list (MM60)', 'Material master list: material group, type and base unit', 62);

-- -----------------------------------------------------------------------------
-- dim_material: what the material is. Group resolution order (gap doc 1.3):
-- ME2N (most frequent group over the material's PO lines), else the material
-- list, else what was already known. group_source records which one won.
-- dim_material_group (020) is joined on material_group = code; no FK, because a
-- material can carry a group the catalogue does not know yet.
-- -----------------------------------------------------------------------------
ALTER TABLE dim_material ADD COLUMN material_group TEXT;
ALTER TABLE dim_material ADD COLUMN material_type  TEXT;
ALTER TABLE dim_material ADD COLUMN base_unit      TEXT;
ALTER TABLE dim_material ADD COLUMN group_source   TEXT;   -- 'ME2N' | 'MATLIST' | NULL (unknown)

-- -----------------------------------------------------------------------------
-- Movement-type rules.
-- -----------------------------------------------------------------------------
CREATE TABLE material_movement_rule (
  rule_id     INTEGER PRIMARY KEY,
  mvt_glob    TEXT NOT NULL,                       -- GLOB over the (upper-cased) movement type
  kind        TEXT NOT NULL CHECK (kind IN ('ISSUE','OUTSIDE')),
  issue_type  TEXT CHECK (issue_type IN ('P','S','X')),   -- ISSUE rows only
  group_label TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX ux_mmr_glob ON material_movement_rule(mvt_glob);

INSERT INTO material_movement_rule (mvt_glob, kind, issue_type, group_label, priority)
SELECT value, 'ISSUE', 'P', 'Issued to the project', 10 FROM json_each('["221","222","281","282"]');
INSERT INTO material_movement_rule (mvt_glob, kind, issue_type, group_label, priority)
SELECT value, 'ISSUE', 'S', 'Issued to subcontractors (recoverable)', 10 FROM json_each('["Z21","Z22"]');
INSERT INTO material_movement_rule (mvt_glob, kind, issue_type, group_label, priority)
SELECT value, 'ISSUE', 'X', 'Scrap', 10 FROM json_each('["551","552","553","554","555","556"]');

INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority)
SELECT value, 'OUTSIDE', 'Receipts, and returns to the vendor', 100
FROM json_each('["101","102","103","104","105","106","122","123","124","125","161","162"]');
INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority)
SELECT value, 'OUTSIDE', 'Transfers between plants and storage locations', 100
FROM json_each('["301","302","303","304","305","306","309","310","311","312","313","314","315","316","351","352","641","642","643","644"]');
INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority)
SELECT value, 'OUTSIDE', 'Deliveries', 100 FROM json_each('["601","602","651","652","653","654"]');
INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority)
SELECT value, 'OUTSIDE', 'Issued to orders - not project cost', 100 FROM json_each('["261","262"]');
INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority)
SELECT value, 'OUTSIDE', 'Issued to cost centres - not project cost', 100 FROM json_each('["201","202"]');
INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority)
SELECT value, 'OUTSIDE', 'Issued to assets or other objects - not project cost', 100
FROM json_each('["241","242","291","292"]');
INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority)
SELECT value, 'OUTSIDE', 'Provided to subcontractor stock (not consumed yet)', 100
FROM json_each('["541","542","543","544"]');
INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority)
SELECT value, 'OUTSIDE', 'Initial entry of stock balances', 100
FROM json_each('["561","562","563","564","565","566"]');
INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority)
SELECT value, 'OUTSIDE', 'Inventory differences', 100
FROM json_each('["701","702","707","708","711","712","717","718"]');
INSERT INTO material_movement_rule (mvt_glob, kind, group_label, priority) VALUES
  ('Z5[0-9]', 'OUTSIDE', 'Owner-supplied (customer) stock', 100),
  ('Z8[0-9]', 'OUTSIDE', 'Scrap taken back from the project', 100);

-- -----------------------------------------------------------------------------
-- MB51 material-document lines, exactly as SAP prints them (SAP sign). Every
-- movement is staged and stored - receipts and transfers included - because the
-- file's own total row (import_batch.control_total) covers all of them and the
-- Checks need to list what was left out. The views decide what counts.
-- -----------------------------------------------------------------------------
CREATE TABLE fact_material_issue (
  issue_id          INTEGER PRIMARY KEY,
  import_batch_id   INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  project_key       INTEGER NOT NULL REFERENCES dim_project(project_key),
  material_key      INTEGER NOT NULL REFERENCES dim_material(material_key),
  wbs_key           INTEGER REFERENCES dim_wbs(wbs_key),
  vendor_key        INTEGER REFERENCES dim_vendor(vendor_key),     -- SAP "Supplier" (the subcontractor on Z21)
  plant             TEXT,
  storage_location  TEXT,
  movement_type     TEXT NOT NULL,
  movement_text     TEXT,
  document_no       TEXT,
  fiscal_year       TEXT,                                          -- "Material Doc. Year"
  document_line     TEXT,                                          -- "Material Doc.Item"
  posting_date_key  INTEGER,                                       -- YYYYMMDD; NULL = no posting date
  entry_date_key    INTEGER,
  quantity          REAL,                                          -- SAP sign
  amount            REAL NOT NULL DEFAULT 0,                       -- SAP sign (Amt.in Loc.Cur.)
  uom               TEXT,
  order_no          TEXT,
  reservation_no    TEXT,
  valuation_type    TEXT,
  user_name         TEXT,
  header_text       TEXT,
  item_text         TEXT,
  source_row_no     INTEGER,
  line_uid          TEXT
);
CREATE INDEX ix_mi_batch   ON fact_material_issue(import_batch_id);
CREATE INDEX ix_mi_project ON fact_material_issue(project_key, posting_date_key);
CREATE INDEX ix_mi_mat     ON fact_material_issue(project_key, material_key);
CREATE UNIQUE INDEX ux_mi_uid ON fact_material_issue(line_uid);

-- Every posted movement with its classification. Not a reporting view: it is the
-- base of the two issue views and of the Checks (movements left out, unknown
-- movement types, zero-value lines). amount / quantity are cost-signed.
CREATE VIEW v_material_movement AS
SELECT
  m.*,
  CASE WHEN m.posting_date IS NOT NULL THEN CAST(SUBSTR(m.posting_date, 1, 4) AS INTEGER) END AS year_no,
  CASE WHEN m.posting_date IS NOT NULL THEN CAST(SUBSTR(m.posting_date, 6, 2) AS INTEGER) END AS month_no,
  CASE WHEN m.posting_date IS NOT NULL THEN SUBSTR(m.posting_date, 1, 7) END                AS period_key
FROM (
  SELECT
    f.issue_id, f.import_batch_id, b.data_date, f.line_uid,
    p.project_key, p.project_code, p.project_name,
    mat.material_key, mat.material_code, mat.material_name,
    mat.material_group, mat.material_type, mat.base_unit, mat.group_source,
    g.name     AS material_group_name,
    g.family   AS family,
    g.division AS division,
    g.sort_order AS group_sort_order,
    f.plant, f.storage_location, f.movement_type, f.movement_text,
    COALESCE(r.kind, 'UNKNOWN') AS movement_kind,          -- ISSUE | OUTSIDE | UNKNOWN
    r.issue_type,
    CASE r.issue_type WHEN 'P' THEN 'Project' WHEN 'S' THEN 'To subcontractors' WHEN 'X' THEN 'Scrap' END
                                                           AS issue_type_name,
    r.group_label AS movement_group,
    w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path,
    v.vendor_key, v.vendor_code, v.vendor_name,
    f.document_no, f.fiscal_year, f.document_line,
    CASE WHEN f.posting_date_key IS NOT NULL THEN
      printf('%04d-%02d-%02d', f.posting_date_key / 10000,
             (f.posting_date_key / 100) % 100, f.posting_date_key % 100) END AS posting_date,
    CASE WHEN f.entry_date_key IS NOT NULL THEN
      printf('%04d-%02d-%02d', f.entry_date_key / 10000,
             (f.entry_date_key / 100) % 100, f.entry_date_key % 100) END     AS entry_date,
    -f.amount   AS amount,             -- cost: an issue is positive, a return negative
    -f.quantity AS quantity,
    f.amount    AS sap_amount,
    f.quantity  AS sap_quantity,
    f.uom, f.order_no, f.reservation_no, f.valuation_type, f.user_name,
    f.header_text, f.item_text, f.source_row_no
  FROM fact_material_issue f
  JOIN import_batch b   ON b.import_batch_id = f.import_batch_id
  JOIN dim_project p    ON p.project_key = f.project_key
  JOIN dim_material mat ON mat.material_key = f.material_key
  LEFT JOIN dim_material_group g ON g.code = mat.material_group
  LEFT JOIN material_movement_rule r ON r.rule_id = (
    SELECT r2.rule_id FROM material_movement_rule r2
    WHERE f.movement_type GLOB r2.mvt_glob ORDER BY r2.priority, r2.rule_id LIMIT 1)
  LEFT JOIN dim_wbs w    ON w.wbs_key = f.wbs_key
  LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
  WHERE b.status = 'POSTED'
) m;

-- Issues that are material cost (ISSUE movements with a value), WITHOUT the
-- cut-off. pending_reason says why a line is held back: after the project's
-- cut-off, or no posting date (it cannot be placed in a month). Only status
-- queries read this; reports read v_material_issue.
CREATE VIEW v_material_issue_all AS
SELECT
  m.*,
  CASE
    WHEN m.posting_date IS NULL THEN 'No posting date'
    WHEN pc.cutoff_date IS NOT NULL AND m.posting_date > pc.cutoff_date THEN 'After cut-off'
  END AS pending_reason
FROM v_material_movement m
LEFT JOIN project_cutoff pc ON pc.project_key = m.project_key
WHERE m.movement_kind = 'ISSUE' AND m.amount <> 0;

-- The reporting view: v_material_issue_all held to the project's cut-off, the
-- way v_posting holds v_posting_all. Unlike a CJI3 line there is no period to
-- fall back on, so a line with no posting date never counts (even with no
-- cut-off set) - the report tool treats it as Pending too.
CREATE VIEW v_material_issue AS
SELECT * FROM v_material_issue_all WHERE pending_reason IS NULL;

-- -----------------------------------------------------------------------------
-- ME2N purchase-order lines (materials only). Keyed on PO + item. A line with
-- no material (a service or text line) is not loaded.
-- -----------------------------------------------------------------------------
CREATE TABLE fact_po_material_line (
  po_material_line_id INTEGER PRIMARY KEY,
  import_batch_id     INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  project_key         INTEGER NOT NULL REFERENCES dim_project(project_key),
  material_key        INTEGER NOT NULL REFERENCES dim_material(material_key),
  vendor_key          INTEGER REFERENCES dim_vendor(vendor_key),   -- purchase lines only
  po_no               TEXT NOT NULL,
  po_item             TEXT,
  document_date_key   INTEGER,
  supplier_text       TEXT,                                        -- "Supplier/Supplying Plant" as printed
  plant               TEXT,
  material_group      TEXT,
  short_text          TEXT,
  order_unit          TEXT,
  deletion_flag       TEXT,                                        -- 'L' = deleted
  order_qty           REAL,
  price_unit          REAL,
  net_price           REAL,
  net_value           REAL,
  open_qty            REAL,                                        -- still to be delivered
  open_value          REAL,
  invoice_qty         REAL,                                        -- still to be invoiced
  invoice_value       REAL,
  source_row_no       INTEGER,
  line_uid            TEXT
);
CREATE INDEX ix_pml_batch ON fact_po_material_line(import_batch_id);
CREATE INDEX ix_pml_mat   ON fact_po_material_line(project_key, material_key);
CREATE UNIQUE INDEX ux_pml_uid ON fact_po_material_line(line_uid);

-- kind: a stock transport order from own stores names a supplying plant or
-- storage location (SBD1, C002) instead of a numeric vendor number and carries
-- no price; everything else is a purchase (PUR). unit_price = net price per
-- single unit. A deleted line is neither ordered nor open (is_deleted).
CREATE VIEW v_po_material_line AS
SELECT
  f.po_material_line_id, f.import_batch_id, b.data_date,
  p.project_key, p.project_code, p.project_name,
  mat.material_key, mat.material_code, mat.material_name,
  COALESCE(NULLIF(f.material_group, ''), mat.material_group) AS material_group,
  v.vendor_key, v.vendor_code, v.vendor_name,
  f.po_no, f.po_item,
  CASE WHEN f.document_date_key IS NOT NULL THEN
    printf('%04d-%02d-%02d', f.document_date_key / 10000,
           (f.document_date_key / 100) % 100, f.document_date_key % 100) END AS document_date,
  f.supplier_text, f.plant, f.short_text, f.order_unit,
  UPPER(COALESCE(f.deletion_flag, '')) = 'L' AS is_deleted,
  CASE WHEN SUBSTR(COALESCE(f.supplier_text, ''), 1, INSTR(COALESCE(f.supplier_text, '') || ' ', ' ') - 1)
            NOT GLOB '*[^0-9]*'
        AND COALESCE(f.supplier_text, '') <> '' THEN 'PUR' ELSE 'STO' END    AS kind,
  f.order_qty, f.price_unit, f.net_price, f.net_value,
  CASE WHEN COALESCE(f.net_price, 0) <> 0
       THEN f.net_price / COALESCE(NULLIF(f.price_unit, 0), 1) ELSE 0 END    AS unit_price,
  f.open_qty, f.open_value, f.invoice_qty, f.invoice_value
FROM fact_po_material_line f
JOIN import_batch b   ON b.import_batch_id = f.import_batch_id
JOIN dim_project p    ON p.project_key = f.project_key
JOIN dim_material mat ON mat.material_key = f.material_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
WHERE b.status = 'POSTED';

-- Weighted PO price per material (the tool's meIndex "wavg"): the unit prices of
-- the material's purchase lines weighted by order qty; deleted lines and stock
-- transfers left out. With no positive quantity it falls back to the plain mean.
CREATE VIEW v_po_material_price AS
SELECT
  project_key, material_key, material_code,
  COUNT(*)                                                         AS price_lines,
  CASE WHEN SUM(order_qty) > 0 THEN SUM(unit_price * order_qty) / SUM(order_qty)
       ELSE AVG(unit_price) END                                    AS weighted_price,
  MIN(unit_price)                                                  AS lowest_price,
  MAX(unit_price)                                                  AS highest_price,
  SUM(order_qty)                                                   AS ordered_qty,
  SUM(open_qty)                                                    AS open_qty,
  SUM(open_value)                                                  AS open_value
FROM v_po_material_line
WHERE kind = 'PUR' AND is_deleted = 0 AND unit_price > 0
GROUP BY project_key, material_key, material_code;

-- -----------------------------------------------------------------------------
-- Report definitions (no explicit id: ids 11+ are other ports').
-- -----------------------------------------------------------------------------
INSERT INTO report_definition
  (source_system_id, code, name, module, description, expected_frequency, staleness_days, detail_key_fields) VALUES
  (1, 'SAP_MB51', 'SAP material documents (MB51)', 'MATISSUE',
   'Material-document movements of the project plant. Goods issues (221/222, Z21/Z22, 551-556) are material cost; the file''s total row has no material.',
   'MONTHLY', 35, '["material_code"]'),
  (1, 'SAP_ME2N', 'SAP purchase order lines (ME2N)', 'MATPO',
   'Purchase order lines of the plant with quantity, price, open and to-invoice; the group of every material that is on an order.',
   'MONTHLY', 35, '["po_no"]'),
  (1, 'SAP_MM60', 'SAP material list (MM60 / MB52)', 'MATLIST',
   'Material, description, material group, type and base unit - gives a group to materials that are on no PO line.',
   'ADHOC', 180, '["material_code"]');

-- -----------------------------------------------------------------------------
-- v_actual_cost: the headline actual (PLAN.md). All v_actual rows except the
-- MATERIAL rows of a project that has MB51 issues loaded, plus those MB51
-- issues (cost_type MATERIAL). A project without MB51 keeps its CJI3 material.
-- "Has MB51" looks at v_material_issue_all, so the cut-off moving never flips
-- a project between the two sources. GL-level screens (Reports pivot,
-- anomalies, UNIFIED_COST_REGISTER) stay on v_actual: MB51 has no GL.
-- -----------------------------------------------------------------------------
CREATE VIEW v_mb51_project AS
SELECT DISTINCT project_key FROM v_material_issue_all;

CREATE VIEW v_actual_cost AS
SELECT
  a.project_key, a.project_code, a.project_name,
  a.wbs_key, a.wbs_code, a.wbs_name, a.wbs_path,
  a.material_code, a.vendor_code, a.vendor_name,
  a.cost_type, a.work_package,
  a.period_key, a.year_no, a.month_no, a.posting_date,
  a.import_batch_id, a.data_date,
  a.amount, 'CJI3' AS source
FROM v_actual a
WHERE a.cost_type IS NOT 'MATERIAL'
   OR a.project_key NOT IN (SELECT project_key FROM v_mb51_project)
UNION ALL
SELECT
  m.project_key, m.project_code, m.project_name,
  m.wbs_key, m.wbs_code, m.wbs_name, m.wbs_path,
  m.material_code, m.vendor_code, m.vendor_name,
  'MATERIAL' AS cost_type,
  (SELECT w.work_package FROM material_work_package w
    WHERE w.project_key = m.project_key AND w.material_code = m.material_code) AS work_package,
  m.period_key, m.year_no, m.month_no, m.posting_date,
  m.import_batch_id, m.data_date,
  m.amount, 'MB51' AS source
FROM v_material_issue m;
