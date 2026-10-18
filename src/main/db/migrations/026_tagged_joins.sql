-- =============================================================================
-- v_actual_tagged as joins (performance; same rows and tags as 024).
--
-- 024 decided aside_source with correlated EXISTS subqueries. Reading
-- v_actual_cost filters on that CASE (aside_source IS NULL), and SQLite then
-- re-ran the DISTINCT "has detail" views for every CJI3 line: about 4 s per read
-- on a 40k-line project, several reads per page, all on the main process.
-- Each "has detail" set is now a LEFT JOIN, built once per statement.
-- v_cost_cert_po / v_cost_order_detail are DISTINCT and v_cost_source_active is
-- unique on (cost_type, source), so no join can repeat a CJI3 line.
-- =============================================================================

CREATE INDEX IF NOT EXISTS ix_sl_proj_po ON fact_service_line(project_key, po_no);
CREATE INDEX IF NOT EXISTS ix_ol_proj_order ON fact_order_line(project_key, order_no);

DROP VIEW v_actual_tagged;
CREATE VIEW v_actual_tagged AS
SELECT a.*,
  CASE
    WHEN mb.project_key IS NOT NULL THEN 'MB51'
    WHEN cp.po_no IS NOT NULL THEN 'CERT'
    WHEN od.order_no IS NOT NULL THEN 'ORDER'
  END AS aside_source
FROM v_actual a
-- MB51: every MATERIAL line of a project with MB51 issues
LEFT JOIN (SELECT p.project_key FROM v_mb51_project p
           WHERE EXISTS (SELECT 1 FROM v_cost_source_active r WHERE r.cost_type = 'MATERIAL' AND r.source = 'MB51')) mb
       ON mb.project_key = a.project_key AND a.cost_type = 'MATERIAL'
-- CERT: a line whose PO has certificates, when the rule is on for its cost type
LEFT JOIN v_cost_source_active rc ON rc.source = 'CERT' AND rc.cost_type = a.cost_type
LEFT JOIN v_cost_cert_po cp ON rc.source IS NOT NULL AND cp.project_key = a.project_key AND cp.po_no = a.po_no
-- ORDER: an order settlement whose order has category WBS detail
LEFT JOIN (SELECT o.project_key, o.order_no FROM v_cost_order_detail o
           WHERE EXISTS (SELECT 1 FROM v_cost_source_active r WHERE r.source = 'ORDER')) od
       ON a.partner_object_type = 'Order' AND od.project_key = a.project_key AND od.order_no = a.partner_object;
