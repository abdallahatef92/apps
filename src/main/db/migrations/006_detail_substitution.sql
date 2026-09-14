-- =============================================================================
-- Detail Substitution — naming the pattern.
--
-- The unified cost register substitutes a summary posting in v_actual with its
-- own itemized detail from a secondary report, matched on a shared key (a
-- purchase order, for subcontractors). fact_service_line is already
-- category-agnostic — nothing in it is subcontractor-specific, so any other
-- PO-based detail report (equipment rental, materials reconciliation, whatever
-- the next category is) loads into the same SERVICE module and joins into the
-- register automatically, with no new SQL.
--
-- The one thing that setup could not do: tell two differently-sourced detail
-- reports apart once both are loaded. This exposes which report_definition each
-- service line came from, so the register (and any export) can distinguish
-- "Subcontractor service-line report" from a second detail source without
-- reading raw import_batch_id values.
-- =============================================================================

DROP VIEW IF EXISTS v_service_line;

CREATE VIEW v_service_line AS
SELECT
  f.service_line_id, f.import_batch_id, b.data_date,
  rd.report_definition_id, rd.code AS report_code, rd.name AS report_name,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name, ce.cost_type,
  v.vendor_key, v.vendor_code, v.vendor_name,
  f.period_key, f.po_no, f.invoice_no, f.entry_sheet_no, f.invoice_serial,
  f.item_no, f.line_no, f.service_code, f.service_text, f.category, f.contract_type,
  f.uom, f.unit_rate, f.quantity_total, f.quantity_previous, f.quantity_current,
  f.progress_pct, f.amount_net, f.amount_vat, f.amount_gross
FROM fact_service_line f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN report_definition rd ON rd.report_definition_id = b.report_definition_id
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
WHERE b.status = 'POSTED';

-- The module's own framing was subcontractor-specific; the mechanism is not.
UPDATE module_type
SET name = 'Detail lines', description = 'Line-item detail behind a purchase order, replacing that PO''s summary posting in the actuals — subcontractor certificates, equipment rental, materials reconciliation, or any similarly-shaped report'
WHERE code = 'SERVICE';
