-- =============================================================================
-- The subcontract cost report: everything the monthly service report needs
-- that the certificate upload (ZSCPROG01, module SERVICE) did not yet carry,
-- plus the PO service-line register (ZSCSRV1) as its own module.
--
-- Certificate lines gain:
--   is_approved   'Character 1' = X. Not approved = pending.
--   is_opening    'Flag' = X. An initial (pre go-live) balance line.
--   tax_code      'Tx' — P0/P2/P3, the VAT rate an A2 contract's price includes.
--   profit_center 'Profit Ctr'. A line on another profit centre than the
--                 project's usual one stays in, but is flagged.
--   package_no    'Number' — part of the certificate line's own identity.
--   split_count   How many WBS rows SAP repeated this line on. The importer
--                 keeps one and records the count, so the repeated amount can
--                 still be shown against the file's own grand total.
-- A NULL flag means the column was not in the file (an older upload), so the
-- views read a NULL approval as approved rather than turning every old line
-- into "pending".
--
-- The report's rules (engine.js in the user's standalone tool) become
-- columns of v_service_line: net rate, line class, report quantity, trade,
-- bucket. The lookups they need are data, not CHECK constraints.
--
-- This rebuilds a view other code reads and adds tables with foreign keys,
-- so it manages its own transaction (see MIGRATIONS in src/main/db/index.ts).
-- =============================================================================

PRAGMA foreign_keys = OFF;

BEGIN;

ALTER TABLE fact_service_line ADD COLUMN is_approved   INTEGER;
ALTER TABLE fact_service_line ADD COLUMN is_opening    INTEGER;
ALTER TABLE fact_service_line ADD COLUMN tax_code      TEXT;
ALTER TABLE fact_service_line ADD COLUMN profit_center TEXT;
ALTER TABLE fact_service_line ADD COLUMN package_no    TEXT;
ALTER TABLE fact_service_line ADD COLUMN split_count   INTEGER NOT NULL DEFAULT 1;

-- The file's own grand-total row, when the report prints one. Compared with
-- the lines actually loaded on the Checks tab.
ALTER TABLE import_batch ADD COLUMN control_total REAL;

-- VAT rate an A2 ("price includes VAT") contract's gross price carries.
CREATE TABLE dim_tax_code (
  code     TEXT PRIMARY KEY,
  vat_rate REAL NOT NULL
);
INSERT INTO dim_tax_code (code, vat_rate) VALUES ('P0', 0), ('P2', 0.10), ('P3', 0.14);

-- Trade = the service code's own category: characters 2–3 of an S-code
-- (S0302 → 03), otherwise its first character (L, P).
CREATE TABLE dim_sc_trade (
  code       TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT INTO dim_sc_trade (code, label, sort_order) VALUES
  ('01', '01 General requirements', 1),
  ('03', '03 Concrete', 3),
  ('04', '04 Masonry', 4),
  ('05', '05 Metals', 5),
  ('06', '06 Wood / formwork', 6),
  ('07', '07 Thermal & moisture', 7),
  ('08', '08 Doors & windows', 8),
  ('09', '09 Finishes (plaster)', 9),
  ('10', '10 Specialties', 10),
  ('21', '21 Fire fighting', 21),
  ('22', '22 Plumbing & drainage', 22),
  ('23', '23 HVAC', 23),
  ('26', '26 Electrical', 26),
  ('31', '31 Earthwork', 31),
  ('32', '32 Exterior works', 32),
  ('34', '34 Transportation', 34),
  ('L',  'Labour supply', 90),
  ('P',  'Plant & logistics', 91);

DROP VIEW IF EXISTS v_service_line;

CREATE VIEW v_service_line AS
SELECT
  s.*,
  CASE
    WHEN s.a <> 0 AND (s.q = 0 OR (ABS(s.q) <= 0.01 AND ABS(s.a - s.q * COALESCE(s.net_rate, 0))
                                   > MAX(1, 0.001 * ABS(s.a)))) THEN 'Adjustment'
    WHEN s.q <> 0 AND s.a = 0 THEN 'Qty only'
    ELSE 'Normal'
  END AS line_class,
  -- A Normal line whose amount is not qty × rate is reported at the quantity
  -- its amount is worth (amount ÷ net rate) — the certificate's own qty is
  -- then only a progress figure.
  CASE
    WHEN s.a <> 0 AND (s.q = 0 OR (ABS(s.q) <= 0.01 AND ABS(s.a - s.q * COALESCE(s.net_rate, 0))
                                   > MAX(1, 0.001 * ABS(s.a)))) THEN 0
    WHEN s.q <> 0 AND s.a = 0 THEN 0
    WHEN COALESCE(s.net_rate, 0) <> 0 AND ABS(s.a - s.q * s.net_rate) > 1 THEN s.a / s.net_rate
    ELSE s.q
  END AS report_qty,
  CASE
    WHEN s.a <> 0 AND (s.q = 0 OR (ABS(s.q) <= 0.01 AND ABS(s.a - s.q * COALESCE(s.net_rate, 0))
                                   > MAX(1, 0.001 * ABS(s.a)))) THEN 0
    WHEN s.q <> 0 AND s.a = 0 THEN 0
    WHEN COALESCE(s.net_rate, 0) <> 0 AND ABS(s.a - s.q * s.net_rate) > 1 THEN 1
    ELSE 0
  END AS is_equiv_qty,
  COALESCE((SELECT t.label FROM dim_sc_trade t WHERE t.code = s.trade), 'UNMAPPED') AS trade_label,
  CASE
    WHEN COALESCE(s.is_approved, 1) = 0 THEN 'PENDING'
    WHEN s.is_opening = 1 THEN 'OPENING'
    ELSE s.period_key
  END AS bucket
FROM (
  SELECT
    f.service_line_id, f.import_batch_id, b.data_date,
    rd.report_definition_id, rd.code AS report_code, rd.name AS report_name,
    p.project_key, p.project_code, p.project_name,
    w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path,
    ce.cost_element_key, ce.cost_element_code, ce.cost_element_name,
    CASE
      WHEN COALESCE(ce.posting_nature,'COST') = 'REVENUE' THEN NULL
      WHEN ce.cost_type IS NOT NULL AND ce.cost_type <> 'OTHER' THEN ce.cost_type
      ELSE COALESCE(
        (SELECT r.cost_type FROM cost_type_rule r
          WHERE r.is_active = 1
            AND r.document_type_glob IS NULL
            AND (r.cost_element_glob IS NULL OR ce.cost_element_code GLOB r.cost_element_glob)
          ORDER BY r.priority, r.rule_id
          LIMIT 1),
        ce.cost_type)
    END AS cost_type,
    (SELECT m.work_package FROM service_work_package m
      WHERE m.project_key = p.project_key
        AND m.service_code = COALESCE(f.service_code,'')
        AND m.service_text = COALESCE(f.service_text,'')) AS work_package,
    v.vendor_key, v.vendor_code, v.vendor_name,
    f.period_key, f.po_no, f.invoice_no, f.entry_sheet_no, f.invoice_serial,
    f.item_no, f.line_no, f.package_no, f.service_code, f.service_text, f.category, f.contract_type,
    f.uom, f.unit_rate, f.quantity_total, f.quantity_previous, f.quantity_current,
    f.progress_pct, f.amount_net, f.amount_vat, f.amount_gross,
    f.is_approved, f.is_opening, f.tax_code, f.profit_center, f.split_count, f.line_uid,
    f.invoice_date_key,
    CASE WHEN f.contract_type = 'A2'
         THEN f.unit_rate / (1 + COALESCE(tx.vat_rate, 0))
         ELSE f.unit_rate END AS net_rate,
    CASE WHEN SUBSTR(COALESCE(f.service_code,''), 1, 1) = 'S'
         THEN SUBSTR(f.service_code, 2, 2)
         ELSE SUBSTR(COALESCE(f.service_code,''), 1, 1) END AS trade,
    SUBSTR(COALESCE(f.service_code,''), 1, 1) AS resource_code,
    CASE WHEN f.profit_center IS NOT NULL AND mp.main_pc IS NOT NULL
              AND f.profit_center <> mp.main_pc THEN 1 ELSE 0 END AS is_other_pc,
    COALESCE(f.amount_net, 0) AS a,
    COALESCE(f.quantity_current, 0) AS q
  FROM fact_service_line f
  JOIN import_batch b ON b.import_batch_id = f.import_batch_id
  JOIN report_definition rd ON rd.report_definition_id = b.report_definition_id
  JOIN dim_project p  ON p.project_key = f.project_key
  LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
  LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
  LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
  LEFT JOIN dim_tax_code tx ON tx.code = f.tax_code
  -- The project's usual profit centre: the one most of its lines carry.
  LEFT JOIN (
    SELECT project_key, profit_center AS main_pc FROM (
      SELECT project_key, profit_center,
             ROW_NUMBER() OVER (PARTITION BY project_key ORDER BY COUNT(*) DESC, profit_center) AS rn
      FROM fact_service_line WHERE profit_center IS NOT NULL
      GROUP BY project_key, profit_center)
    WHERE rn = 1
  ) mp ON mp.project_key = f.project_key
  WHERE b.status = 'POSTED'
) s;

-- -----------------------------------------------------------------------------
-- ZSCSRV1 — the PO service-line register. One row per PO service line: the
-- contract quantity and price the certificates are measured against. Keyed
-- on its own identity (PO + item + service line), so a monthly re-export
-- merges rather than accumulates.
-- -----------------------------------------------------------------------------
INSERT INTO module_type (code, name, description, sort_order) VALUES
  ('PO_SERVICE', 'PO service lines', 'Subcontract PO service-line register (contract qty, unit, material group)', 55);

CREATE TABLE fact_po_service_line (
  po_service_line_id  INTEGER PRIMARY KEY,
  import_batch_id     INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  project_key         INTEGER NOT NULL REFERENCES dim_project(project_key),
  vendor_key          INTEGER REFERENCES dim_vendor(vendor_key),
  po_no               TEXT NOT NULL,
  po_item             TEXT,
  po_line_no          TEXT,
  service_code        TEXT,
  service_text        TEXT,
  unit_price          REAL,
  uom                 TEXT,
  material_group      TEXT,
  material_group_desc TEXT,
  works_type          TEXT,
  contract_terms      TEXT,
  contract_qty        REAL,
  contract_price      REAL,
  qty_received        REAL,
  qty_accepted        REAL,
  total_cost          REAL,
  source_row_no       INTEGER,
  line_uid            TEXT
);
CREATE INDEX ix_psl_batch ON fact_po_service_line(import_batch_id);
CREATE INDEX ix_psl_po    ON fact_po_service_line(project_key, po_no);
CREATE UNIQUE INDEX ux_psl_uid ON fact_po_service_line(line_uid);

CREATE VIEW v_po_service_line AS
SELECT
  f.po_service_line_id, f.import_batch_id, b.data_date,
  p.project_key, p.project_code, p.project_name,
  v.vendor_key, v.vendor_code, v.vendor_name,
  f.po_no, f.po_item, f.po_line_no, f.service_code, f.service_text, f.unit_price, f.uom,
  f.material_group, f.material_group_desc, f.works_type, f.contract_terms,
  f.contract_qty, f.contract_price, f.qty_received, f.qty_accepted, f.total_cost,
  'PO' || f.po_no || '_I' || COALESCE(f.po_item,'') || '_L' || COALESCE(f.po_line_no,'') AS po_line_ref
FROM fact_po_service_line f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN dim_project p ON p.project_key = f.project_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
WHERE b.status = 'POSTED';

INSERT INTO report_definition
  (report_definition_id, source_system_id, code, name, module, description,
   expected_frequency, staleness_days, detail_key_fields) VALUES
  (11, 1, 'SAP_ZSCSRV1', 'SAP PO service lines (ZSCSRV1)', 'PO_SERVICE',
   'Every service line on the project''s subcontract POs: contract qty, price, unit, material group, qty received and accepted.',
   'MONTHLY', 35, '["po_no"]');

-- -----------------------------------------------------------------------------
-- Each certificate line matched to its PO service line, tier by tier, the
-- same way the standalone report did it:
--   Exact                 PO + item + service code + text + price
--   Text (price differs)  PO + item + service code + text
--   Service code only     PO + item + service code
-- When a tier finds more than one PO line the lowest-numbered is used and the
-- level says "first of N". Item numbers are compared without leading zeros
-- (the two reports print them differently).
-- -----------------------------------------------------------------------------
CREATE VIEW v_service_line_po_match AS
WITH psl AS (
  SELECT po_service_line_id, project_key, po_no, LTRIM(COALESCE(po_item,''), '0') AS item,
         COALESCE(service_code,'') AS svc, COALESCE(service_text,'') AS txt,
         ROUND(COALESCE(unit_price, 0), 4) AS price
  FROM v_po_service_line
),
e AS (SELECT project_key, po_no, item, svc, txt, price, COUNT(*) n, MIN(po_service_line_id) hit
      FROM psl GROUP BY project_key, po_no, item, svc, txt, price),
t AS (SELECT project_key, po_no, item, svc, txt, COUNT(*) n, MIN(po_service_line_id) hit
      FROM psl GROUP BY project_key, po_no, item, svc, txt),
c AS (SELECT project_key, po_no, item, svc, COUNT(*) n, MIN(po_service_line_id) hit
      FROM psl GROUP BY project_key, po_no, item, svc),
sl AS (
  SELECT service_line_id, project_key, po_no, LTRIM(COALESCE(item_no,''), '0') AS item,
         COALESCE(service_code,'') AS svc, COALESCE(service_text,'') AS txt,
         ROUND(COALESCE(unit_rate, 0), 4) AS price
  FROM v_service_line
)
SELECT
  sl.service_line_id, sl.project_key,
  COALESCE(e.hit, t.hit, c.hit) AS po_service_line_id,
  CASE
    WHEN e.n IS NOT NULL THEN 'Exact' || CASE WHEN e.n > 1 THEN ' – first of ' || e.n ELSE '' END
    WHEN t.n IS NOT NULL THEN 'Text (price differs)' || CASE WHEN t.n > 1 THEN ' – first of ' || t.n ELSE '' END
    WHEN c.n IS NOT NULL THEN 'Service code only' || CASE WHEN c.n > 1 THEN ' – first of ' || c.n ELSE '' END
    ELSE 'Not found'
  END AS match_level
FROM sl
LEFT JOIN e ON e.project_key = sl.project_key AND e.po_no = sl.po_no AND e.item = sl.item
           AND e.svc = sl.svc AND e.txt = sl.txt AND e.price = sl.price
LEFT JOIN t ON t.project_key = sl.project_key AND t.po_no = sl.po_no AND t.item = sl.item
           AND t.svc = sl.svc AND t.txt = sl.txt
LEFT JOIN c ON c.project_key = sl.project_key AND c.po_no = sl.po_no AND c.item = sl.item
           AND c.svc = sl.svc;

-- -----------------------------------------------------------------------------
-- What each certificate upload contained, line by line, as posted. The fact
-- table is upserted on line_uid, so a re-upload overwrites a line in place —
-- this is the history that lets "changes since last load" compare two
-- uploads of the same report.
-- -----------------------------------------------------------------------------
CREATE TABLE service_line_snapshot (
  import_batch_id INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  project_key     INTEGER NOT NULL REFERENCES dim_project(project_key),
  line_uid        TEXT,
  po_no           TEXT,
  vendor_name     TEXT,
  service_code    TEXT,
  service_text    TEXT,
  amount_net      REAL NOT NULL DEFAULT 0,
  is_approved     INTEGER,
  is_opening      INTEGER,
  split_count     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_sls_batch ON service_line_snapshot(import_batch_id);
CREATE INDEX ix_sls_uid   ON service_line_snapshot(project_key, line_uid);

-- Uploads posted before this migration have no snapshot. Seed one from the
-- lines as they stand now, filed under each project's latest certificate
-- upload — the report is cumulative, so that is what the latest file held —
-- so the first new upload already has something to compare against.
INSERT INTO service_line_snapshot
  (import_batch_id, project_key, line_uid, po_no, vendor_name, service_code, service_text,
   amount_net, is_approved, is_opening, split_count)
SELECT lb.import_batch_id, f.project_key, f.line_uid, f.po_no, v.vendor_name, f.service_code, f.service_text,
       f.amount_net, f.is_approved, f.is_opening, f.split_count
FROM fact_service_line f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id AND b.status = 'POSTED'
JOIN (
  SELECT fs.project_key, MAX(fs.import_batch_id) AS import_batch_id
  FROM fact_service_line fs
  JOIN import_batch b2 ON b2.import_batch_id = fs.import_batch_id AND b2.status = 'POSTED'
  GROUP BY fs.project_key
) lb ON lb.project_key = f.project_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key;

COMMIT;

PRAGMA foreign_keys = ON;
