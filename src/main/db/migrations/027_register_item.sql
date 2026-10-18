-- =============================================================================
-- v_actual_cost gains item_code / item_name and quantity / unit (simplification step 3: the Actual cost register).
--
-- Same rows, sources and amounts as 024; two columns added so the register can list each category by
-- what the cost is: CJI3 = its GL account (a subcontract PO with no certificates = 'PO <no>' and its
-- vendor), MB51 = the material, CERT = the service code and text, ORDER = 'Order <no>' and its text.
-- =============================================================================

DROP VIEW v_actual_cost;
CREATE VIEW v_actual_cost AS
SELECT
  a.project_key, a.project_code, a.project_name,
  a.wbs_key, a.wbs_code, a.wbs_name, a.wbs_path,
  a.material_code, a.vendor_code, a.vendor_name,
  a.cost_type, a.work_package,
  a.period_key, a.year_no, a.month_no, a.posting_date,
  a.import_batch_id, a.data_date,
  a.amount, 'CJI3' AS source,
  -- the register's row item: a subcontract PO with no certificates shows as its PO, anything else as its GL
  CASE WHEN a.cost_type = 'SUBCONTRACT' AND COALESCE(a.po_no, '') <> '' THEN 'PO ' || a.po_no ELSE a.cost_element_code END AS item_code,
  CASE WHEN a.cost_type = 'SUBCONTRACT' AND COALESCE(a.po_no, '') <> '' THEN COALESCE(a.vendor_name, a.cost_element_name)
       ELSE a.cost_element_name END AS item_name,
  a.quantity, a.uom AS unit
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
  m.amount, 'MB51' AS source,
  m.material_code AS item_code, m.material_name AS item_name,
  m.quantity, COALESCE(m.uom, m.base_unit) AS unit
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
  s.amount_net AS amount, 'CERT' AS source,
  COALESCE(NULLIF(s.service_code, ''), '(no code)') AS item_code, s.service_text AS item_name,
  -- the report quantity (an adjustment line in equivalent qty at its PO line's rate), as the SC report counts it
  s.report_qty AS quantity, s.uom AS unit
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
  o.amount, 'ORDER' AS source,
  'Order ' || o.order_no AS item_code, o.order_description AS item_name,
  o.quantity, o.uom AS unit
FROM v_order_line o
LEFT JOIN dim_period d ON d.period_key = o.period_key
LEFT JOIN project_cutoff pc ON pc.project_key = o.project_key
WHERE o.category = 'WBS'
  AND EXISTS (SELECT 1 FROM v_cost_source_active r WHERE r.source = 'ORDER')
  AND NOT (o.cost_type = 'MATERIAL' AND o.project_key IN (SELECT project_key FROM v_mb51_project))
  AND (pc.cutoff_date IS NULL OR d.end_date <= pc.cutoff_date);
