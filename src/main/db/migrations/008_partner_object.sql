-- =============================================================================
-- Capture the settlement receiver CJI3 already names.
--
-- An internal order settling into a WBS shows up in CJI3 as an ordinary actual
-- line — same document number, posting row and fiscal year as anything else —
-- but with "Partner Object Type" = Order and "Partner Object" carrying the
-- order number. Document type is blank on these lines because the posting has
-- no invoice or PO behind it; the settlement run is the document.
--
-- This migration only captures that identity. It is not yet a Detail
-- Substitution source: nothing is excluded from v_actual here, because there
-- is not yet a detail report to substitute in for it (see CLAUDE.md — a
-- posting must never be excluded from actuals without something replacing
-- it). Once an order-level detail report exists, its exclusion in
-- UNIFIED_COST_REGISTER will key on partner_object the same way the PO
-- exclusion keys on po_no.
-- =============================================================================

ALTER TABLE fact_actual ADD COLUMN partner_object_type TEXT;
ALTER TABLE fact_actual ADD COLUMN partner_object      TEXT;
ALTER TABLE fact_actual ADD COLUMN partner_object_name TEXT;

CREATE INDEX ix_actual_partner_object ON fact_actual(partner_object);

DROP VIEW IF EXISTS v_revenue;
DROP VIEW IF EXISTS v_actual;
DROP VIEW IF EXISTS v_posting;

CREATE VIEW v_posting AS
SELECT
  f.actual_id, f.import_batch_id, f.line_uid, b.data_date, b.report_definition_id,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.wbs_level,
  w.discipline, w.package, w.control_account,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name,
  CASE
    WHEN COALESCE(ce.posting_nature,'COST') = 'REVENUE' THEN NULL
    WHEN ce.cost_type IS NOT NULL AND ce.cost_type <> 'OTHER' THEN ce.cost_type
    ELSE COALESCE(
      (SELECT r.cost_type FROM cost_type_rule r
        WHERE r.is_active = 1
          AND (r.cost_element_glob  IS NULL OR ce.cost_element_code        GLOB r.cost_element_glob)
          AND (r.document_type_glob IS NULL OR COALESCE(f.document_type,'') GLOB r.document_type_glob)
        ORDER BY r.priority, r.rule_id
        LIMIT 1),
      ce.cost_type)
  END AS cost_type,
  COALESCE(ce.posting_nature,'COST') AS posting_nature,
  v.vendor_key, v.vendor_code, v.vendor_name,
  cur.iso_code AS currency_code,
  f.period_key, f.fiscal_year, d.year_no, d.month_no,
  f.document_no, f.document_line, f.document_type, f.reference_no, f.po_no, f.description,
  f.partner_object_type, f.partner_object, f.partner_object_name,
  f.quantity, f.uom, f.amount
FROM fact_actual f
JOIN import_batch b   ON b.import_batch_id = f.import_batch_id
JOIN dim_project p    ON p.project_key = f.project_key
LEFT JOIN dim_wbs w   ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
LEFT JOIN dim_currency cur ON cur.currency_key = f.currency_key
LEFT JOIN dim_period d ON d.period_key = f.period_key
WHERE b.status = 'POSTED';

CREATE VIEW v_actual AS
SELECT * FROM v_posting WHERE posting_nature = 'COST';

CREATE VIEW v_revenue AS
SELECT
  actual_id, import_batch_id, data_date, project_key, project_code, project_name,
  wbs_key, wbs_code, wbs_name, wbs_path,
  cost_element_key, cost_element_code, cost_element_name,
  period_key, year_no, month_no, document_no, document_type, description,
  -amount AS amount
FROM v_posting WHERE posting_nature = 'REVENUE';
