-- =============================================================================
-- Order settlement detail — a second Detail Substitution source, keyed on an
-- internal order number rather than a purchase order.
--
-- CJI3 already names the receiver of a settlement on the posting itself
-- (migration 008: partner_object_type = 'Order', partner_object = the order
-- number). This migration adds the other side: the order's own line-item
-- detail, reported per (order, cost element, period) rather than per PO.
--
-- The shape does not fit fact_service_line — there is no invoice, entry sheet
-- or progress percentage here, only a CO line item on an Order object instead
-- of a WBS object, plus one field service_line does not need: `category`
-- ('WBS' when the line has settled onto a project WBS element, 'CTR' while it
-- still sits on a cost centre, not yet part of any project's cost). Only
-- category = 'WBS' rows belong in a project's cost register; a 'CTR' row is
-- real spend, but it has not reached this or any project yet, so it must not
-- be summed into one.
--
-- No column in the source report identifies a line uniquely (no document or
-- item number, and two genuinely different postings can share every other
-- field), so — per the same rule as budget, forecast and master data — this
-- never gets a line_uid and always falls back to batch superseding.
-- =============================================================================

INSERT INTO module_type (code, name, description, sort_order) VALUES
  ('ORDER','Order settlement detail','Internal-order cost line items that settle onto a project WBS',7);

CREATE TABLE fact_order_line (
  order_line_id      INTEGER PRIMARY KEY,
  import_batch_id    INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  project_key        INTEGER NOT NULL REFERENCES dim_project(project_key),
  wbs_key            INTEGER REFERENCES dim_wbs(wbs_key),          -- NULL while category = 'CTR'
  cost_element_key   INTEGER REFERENCES dim_cost_element(cost_element_key),
  vendor_key         INTEGER REFERENCES dim_vendor(vendor_key),    -- business partner
  currency_key       INTEGER REFERENCES dim_currency(currency_key),
  period_key         TEXT REFERENCES dim_period(period_key),
  order_no           TEXT,                -- joins to fact_actual.partner_object
  order_description  TEXT,
  order_type         TEXT,
  category           TEXT,                -- 'WBS' settled to a project element, 'CTR' still on a cost centre
  cost_center_code   TEXT,
  cost_center_name   TEXT,
  po_no              TEXT,                -- reference only; not the join key here
  quantity           REAL,
  uom                TEXT,
  amount             REAL NOT NULL DEFAULT 0,
  source_row_no      INTEGER
);
CREATE INDEX ix_ol_batch ON fact_order_line(import_batch_id);
CREATE INDEX ix_ol_order ON fact_order_line(order_no);
CREATE INDEX ix_ol_scope ON fact_order_line(project_key, period_key);
CREATE INDEX ix_ol_wbs ON fact_order_line(wbs_key);

CREATE VIEW v_order_line AS
SELECT
  f.order_line_id, f.import_batch_id, b.data_date,
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
  v.vendor_key, v.vendor_code, v.vendor_name,
  f.period_key, f.order_no, f.order_description, f.order_type,
  f.category, f.cost_center_code, f.cost_center_name, f.po_no,
  f.quantity, f.uom, f.amount
FROM fact_order_line f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN report_definition rd ON rd.report_definition_id = b.report_definition_id
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
WHERE b.status = 'POSTED';

INSERT INTO report_definition
  (report_definition_id, source_system_id, code, name, module, description,
   expected_frequency, staleness_days, detail_key_fields) VALUES
  (9,1,'SAP_ORDER_DETAIL','Internal order detail (ZINTC1)','ORDER',
   'CO line items posted to an internal order rather than a WBS. Only rows already settled to a '
   || 'project WBS element (category = WBS) reconcile against a CJI3 settlement posting; rows still '
   || 'on a cost centre (category = CTR) have not reached the project yet.',
   'MONTHLY',35,'["order_no"]');
