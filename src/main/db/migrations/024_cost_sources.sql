-- =============================================================================
-- Actual-cost source architecture (plan rev. 4): CJI3 feeds every cost category;
-- where a category's detail source is loaded, the detail IS that category's
-- actual cost and the category's CJI3 lines are set aside. The set-aside CJI3
-- amount is reconciled against the detail (COST_SOURCE_RECON), never added.
--
--  1. Cost types: FLEET, HOUSING, DEPRECIATION, GA; EQUIPMENT relabelled.
--     The old custom ASSET_DEPRECIATION type is repointed, never deleted.
--     No GL rules are invented for the new types (the user maps them in Cost types).
--  2. cost_source_rule: per cost type, which detail source replaces CJI3 and how
--     a CJI3 line is matched to "has detail" (per PO / per project / per order).
--  3. service_mnl: per-service SUB / LAB / EQU override. A sibling table, not a
--     column on service_work_package, because that table's assign path deletes and
--     re-inserts the row and a package-less override would need a NULL-package row.
--     v_service_line exposes it as `mnl` (default 'SUB').
--  4. v_actual_cost generalised: v_actual_tagged marks every CJI3 line that is set
--     aside (and by which source); v_actual_set_aside lists them; v_actual_cost is
--     the kept CJI3 lines + MB51 issues + certificate lines + order detail lines.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Cost types
-- ---------------------------------------------------------------------------
INSERT INTO dim_cost_type (code, label, icon, color, sort_order, is_system, mnl) VALUES
  ('FLEET',        'Fleet / Transportation rent', '🚚', '#e6c35a', 45, 1, 'EQU'),
  ('HOUSING',      'House rent',                  '🏠', '#8fb8f0', 46, 1, 'OTHER'),
  ('DEPRECIATION', 'Asset depreciation',          '📉', '#b98ff0', 55, 1, 'OTHER'),
  ('GA',           'G&A (Finance – HR)',          '🏛', '#a0aec0', 58, 1, 'OTHER');

UPDATE dim_cost_type SET label = 'Equipment / Fuel' WHERE code = 'EQUIPMENT';

-- A custom "Asset Depreciation" type (010 seeded ASSET_DEPRECIATION as is_system = 0,
-- a user may have added their own) is replaced by DEPRECIATION: what points at it moves
-- over. The old row is kept (user data) but marked legacy and sorted last.
UPDATE cost_type_rule SET cost_type = 'DEPRECIATION'
 WHERE cost_type IN (SELECT code FROM dim_cost_type
                      WHERE code <> 'DEPRECIATION' AND is_system = 0
                        AND lower(TRIM(label)) = 'asset depreciation');
UPDATE dim_cost_element SET cost_type = 'DEPRECIATION'
 WHERE cost_type IN (SELECT code FROM dim_cost_type
                      WHERE code <> 'DEPRECIATION' AND is_system = 0
                        AND lower(TRIM(label)) = 'asset depreciation');
UPDATE dim_cost_type SET label = TRIM(label) || ' (legacy)', sort_order = 900
 WHERE code <> 'DEPRECIATION' AND is_system = 0 AND lower(TRIM(label)) = 'asset depreciation';

-- ---------------------------------------------------------------------------
-- 2. cost_source_rule
-- ---------------------------------------------------------------------------
-- cost_type '*' = any type (an order settlement's CJI3 posting carries the
-- settlement GL's type, not the type its detail lines resolve to). The ORDER rows
-- are matched per order, whatever the type: the named rows say which types the
-- detail feeds; the source is switched on/off as a whole (any active ORDER row).
-- match_key: PO = per purchase order, PROJECT = whole project, ORDER = per order.
-- is_active = 0: the source's module does not exist yet; the mechanism is ready.
CREATE TABLE cost_source_rule (
  cost_type   TEXT NOT NULL,
  source      TEXT NOT NULL,                 -- value of v_actual_cost.source for the detail
  detail_view TEXT,
  match_key   TEXT NOT NULL CHECK (match_key IN ('PO','PROJECT','ORDER')),
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  PRIMARY KEY (cost_type, source)
);

INSERT INTO cost_source_rule (cost_type, source, detail_view, match_key, description, is_active) VALUES
  ('SUBCONTRACT', 'CERT',   'v_service_line',  'PO',
   'ZSCPROG01 certificates (To date) replace the CJI3 subcontract postings of every PO that has certificates loaded.', 1),
  ('MATERIAL',    'MB51',   'v_material_issue','PROJECT',
   'MB51 issues replace all CJI3 material postings of a project that has MB51 loaded.', 1),
  ('EQUIPMENT',   'ORDER',  'v_order_line',    'ORDER',
   'ZINT01 order settlement detail (WBS rows only) replaces the CJI3 settlement posting of that order.', 1),
  ('FLEET',       'ORDER',  'v_order_line',    'ORDER',
   'ZINT01 order settlement detail (WBS rows only) replaces the CJI3 settlement posting of that order.', 1),
  ('HOUSING',     'ORDER',  'v_order_line',    'ORDER',
   'ZINT01 order settlement detail (WBS rows only) replaces the CJI3 settlement posting of that order.', 1),
  ('*',           'ORDER',  'v_order_line',    'ORDER',
   'Any other type whose CJI3 line is an order settlement is replaced by its order detail too.', 1),
  ('LABOR',       'LABOUR', 'v_labour_allocation (future)', 'PROJECT',
   'Labour Allocation Form (offline Excel) will replace CJI3 labour. Inactive until the module exists.', 0),
  ('DEPRECIATION','ASSET',  'v_asset_movement (future)',    'PROJECT',
   'Asset Movement Sheet (offline Excel) will replace CJI3 depreciation. Inactive until the module exists.', 0);

CREATE VIEW v_cost_source_active AS
SELECT cost_type, source, match_key FROM cost_source_rule WHERE is_active = 1;

-- ---------------------------------------------------------------------------
-- 3. Per-service MNL override
-- ---------------------------------------------------------------------------
CREATE TABLE service_mnl (
  project_key  INTEGER NOT NULL REFERENCES dim_project(project_key),
  service_code TEXT    NOT NULL,
  service_text TEXT    NOT NULL,
  mnl          TEXT    NOT NULL CHECK (mnl IN ('SUB','LAB','EQU')),
  PRIMARY KEY (project_key, service_code, service_text)
);

-- v_service_line / v_service_line_all gain `mnl`; v_service_line_core is untouched.
DROP VIEW IF EXISTS v_actual_cost;
DROP VIEW IF EXISTS v_service_line_po_match;
DROP VIEW IF EXISTS v_service_line;
DROP VIEW IF EXISTS v_service_line_all;

CREATE VIEW v_service_line_all AS
SELECT
  m.*,
  CASE WHEN m.pend_reason IS NOT NULL THEN 'PENDING'
       WHEN m.is_opening = 1 THEN 'OPENING'
       ELSE m.period_key END AS bucket,
  CASE WHEN m.pend_reason IS NOT NULL THEN 'PENDING'
       WHEN m.is_opening = 1 THEN 'OPENING'
       WHEN m.period_key < m.report_month THEN 'PREVIOUS'
       ELSE 'THIS_MONTH' END AS report_bucket,
  COALESCE((SELECT sm.mnl FROM service_mnl sm
             WHERE sm.project_key = m.project_key
               AND sm.service_code = COALESCE(m.service_code, '')
               AND sm.service_text = COALESCE(m.service_text, '')), 'SUB') AS mnl
FROM (
  SELECT k.*,
    (MAX(CASE WHEN k.pend_reason IS NULL AND COALESCE(k.is_opening, 0) = 0 AND k.a <> 0 THEN k.period_key END)
       OVER (PARTITION BY k.project_key)) AS report_month
  FROM (
    SELECT c.*,
      CASE
        WHEN COALESCE(c.is_approved, 1) = 0 THEN 'Not approved'
        WHEN c.eff_date IS NULL THEN 'No date'
      END AS pend_reason
    FROM v_service_line_core c
  ) k
) m;

CREATE VIEW v_service_line AS
SELECT
  m.*,
  CASE WHEN m.pend_reason IS NOT NULL THEN 'PENDING'
       WHEN m.is_opening = 1 THEN 'OPENING'
       ELSE m.period_key END AS bucket,
  CASE WHEN m.pend_reason IS NOT NULL THEN 'PENDING'
       WHEN m.is_opening = 1 THEN 'OPENING'
       WHEN m.period_key < m.report_month THEN 'PREVIOUS'
       ELSE 'THIS_MONTH' END AS report_bucket,
  COALESCE((SELECT sm.mnl FROM service_mnl sm
             WHERE sm.project_key = m.project_key
               AND sm.service_code = COALESCE(m.service_code, '')
               AND sm.service_text = COALESCE(m.service_text, '')), 'SUB') AS mnl
FROM (
  SELECT k.*,
    COALESCE(SUBSTR(k.cutoff_date, 1, 7),
      MAX(CASE WHEN k.pend_reason IS NULL AND COALESCE(k.is_opening, 0) = 0 AND k.a <> 0 THEN k.period_key END)
        OVER (PARTITION BY k.project_key)) AS report_month
  FROM (
    SELECT c.*,
      CASE
        WHEN COALESCE(c.is_approved, 1) = 0 THEN 'Not approved'
        WHEN c.eff_date IS NULL THEN 'No date'
        WHEN c.cutoff_date IS NOT NULL AND c.eff_date > c.cutoff_date THEN 'After cut date'
      END AS pend_reason
    FROM v_service_line_core c
  ) k
) m;

-- Unchanged from 019_sc_port.sql.
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

-- ---------------------------------------------------------------------------
-- 4. v_actual_cost, generalised
-- ---------------------------------------------------------------------------
-- "Has detail loaded" keys. They read the fact tables (posted batches), not the
-- cut-off-held views, so moving the cut-off never flips a PO / order between sources.
CREATE VIEW v_cost_cert_po AS
SELECT DISTINCT f.project_key, f.po_no
FROM fact_service_line f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
WHERE b.status = 'POSTED' AND f.po_no IS NOT NULL AND f.po_no <> '';

CREATE VIEW v_cost_order_detail AS
SELECT DISTINCT f.project_key, f.order_no
FROM fact_order_line f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
WHERE b.status = 'POSTED' AND f.category = 'WBS' AND f.order_no IS NOT NULL AND f.order_no <> '';

-- Every CJI3 cost line, tagged with the detail source that replaces it (NULL = kept).
-- First match wins: MB51 (project-wide), certificates (per PO), order detail (per order).
CREATE VIEW v_actual_tagged AS
SELECT a.*,
  CASE
    WHEN a.cost_type = 'MATERIAL'
         AND a.project_key IN (SELECT project_key FROM v_mb51_project)
         AND EXISTS (SELECT 1 FROM v_cost_source_active r WHERE r.cost_type = a.cost_type AND r.source = 'MB51')
      THEN 'MB51'
    WHEN a.po_no IS NOT NULL AND a.po_no <> ''
         AND EXISTS (SELECT 1 FROM v_cost_source_active r WHERE r.cost_type = a.cost_type AND r.source = 'CERT')
         AND EXISTS (SELECT 1 FROM v_cost_cert_po c WHERE c.project_key = a.project_key AND c.po_no = a.po_no)
      THEN 'CERT'
    WHEN a.partner_object_type = 'Order' AND a.partner_object IS NOT NULL AND a.partner_object <> ''
         AND EXISTS (SELECT 1 FROM v_cost_source_active r WHERE r.source = 'ORDER')
         AND EXISTS (SELECT 1 FROM v_cost_order_detail o WHERE o.project_key = a.project_key AND o.order_no = a.partner_object)
      THEN 'ORDER'
  END AS aside_source
FROM v_actual a;

CREATE VIEW v_actual_set_aside AS
SELECT * FROM v_actual_tagged WHERE aside_source IS NOT NULL;

CREATE VIEW v_actual_cost AS
SELECT
  a.project_key, a.project_code, a.project_name,
  a.wbs_key, a.wbs_code, a.wbs_name, a.wbs_path,
  a.material_code, a.vendor_code, a.vendor_name,
  a.cost_type, a.work_package,
  a.period_key, a.year_no, a.month_no, a.posting_date,
  a.import_batch_id, a.data_date,
  a.amount, 'CJI3' AS source
FROM v_actual_tagged a
WHERE a.aside_source IS NULL
UNION ALL
-- MB51 issues (the material cost of a project that has MB51 loaded)
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
FROM v_material_issue m
WHERE EXISTS (SELECT 1 FROM v_cost_source_active r WHERE r.cost_type = 'MATERIAL' AND r.source = 'MB51')
UNION ALL
-- Subcontract certificate lines counted at the cut-off (To date; pending lines are
-- held back). The service's MNL says which cost type it reports under.
SELECT
  s.project_key, s.project_code, s.project_name,
  s.wbs_key, s.wbs_code, s.wbs_name, s.wbs_path,
  NULL AS material_code, s.vendor_code, s.vendor_name,
  CASE s.mnl WHEN 'LAB' THEN 'LABOR' WHEN 'EQU' THEN 'EQUIPMENT' ELSE 'SUBCONTRACT' END AS cost_type,
  s.work_package,
  COALESCE(s.period_key, SUBSTR(s.eff_date, 1, 7)) AS period_key,
  CAST(SUBSTR(COALESCE(s.period_key, SUBSTR(s.eff_date, 1, 7)), 1, 4) AS INTEGER) AS year_no,
  CAST(SUBSTR(COALESCE(s.period_key, SUBSTR(s.eff_date, 1, 7)), 6, 2) AS INTEGER) AS month_no,
  s.eff_date AS posting_date,
  s.import_batch_id, s.data_date,
  s.amount_net AS amount, 'CERT' AS source
FROM v_service_line s
WHERE s.pend_reason IS NULL
  AND EXISTS (SELECT 1 FROM v_cost_source_active r WHERE r.cost_type = 'SUBCONTRACT' AND r.source = 'CERT')
UNION ALL
-- Order settlement detail (category WBS only; CTR rows have not reached a project).
-- Cost type = the detail line's own GL through cost_type_rule (v_order_line). Held to
-- the cut-off by its period's end date (the same fallback v_posting uses).
SELECT
  o.project_key, o.project_code, o.project_name,
  o.wbs_key, o.wbs_code, o.wbs_name, o.wbs_path,
  NULL AS material_code, o.vendor_code, o.vendor_name,
  o.cost_type,
  CASE WHEN o.cost_type = 'MATERIAL' THEN NULL
       ELSE COALESCE(
         (SELECT m.work_package FROM cost_element_work_package m
           WHERE m.project_key = o.project_key AND m.cost_element_code = o.cost_element_code),
         CASE WHEN o.cost_type IS NOT NULL AND o.cost_type <> 'SUBCONTRACT' THEN 'INDIRECT' END)
  END AS work_package,
  o.period_key, d.year_no, d.month_no, d.end_date AS posting_date,
  o.import_batch_id, o.data_date,
  o.amount, 'ORDER' AS source
FROM v_order_line o
LEFT JOIN dim_period d ON d.period_key = o.period_key
LEFT JOIN project_cutoff pc ON pc.project_key = o.project_key
WHERE o.category = 'WBS'
  AND EXISTS (SELECT 1 FROM v_cost_source_active r WHERE r.source = 'ORDER')
  AND NOT (o.cost_type = 'MATERIAL' AND o.project_key IN (SELECT project_key FROM v_mb51_project))
  AND (pc.cutoff_date IS NULL OR d.end_date <= pc.cutoff_date);
