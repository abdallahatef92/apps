-- =============================================================================
-- Cost type becomes a rule, not a constant.
--
-- Cost type used to be decided once per cost element, at import, from account
-- ranges written into importer.ts (301 equipment, 302 material, 303 labour,
-- 305 subcontract ...). Two problems with that:
--
--   1. Those ranges are one particular operating chart. The revenue pattern was
--      already promoted to a setting "because charts of accounts differ"; the
--      same argument applies here and was never followed through.
--   2. It was sticky. `cost_type = COALESCE(cost_type, ?)` meant the first file
--      to classify an account won permanently, and nothing could correct it —
--      settings:reclassify only ever recomputed posting_nature.
--
-- The account code is also not always enough. The same cost element carries
-- genuinely different cost under different SAP document types, so the rule has
-- to see the posting, not just the account. document_type lives on fact_actual,
-- which is why cost type can no longer be an attribute of dim_cost_element:
-- it is resolved per posting row, in the views.
--
-- Consequence worth stating: classification is now live. Editing a rule changes
-- every report immediately — no re-import, and history is corrected too.
--
-- The seeded rules reproduce the old hard-coded ranges exactly, so upgrading an
-- existing warehouse does not move a single number.
-- =============================================================================

CREATE TABLE cost_type_rule (
  rule_id            INTEGER PRIMARY KEY,
  -- Lowest priority number wins. Gaps are deliberate: they leave room to insert
  -- a more specific rule above an existing one without renumbering.
  priority           INTEGER NOT NULL,
  -- GLOB patterns, NULL meaning "any". GLOB rather than a regular expression so
  -- the match happens in SQL, inside the view, with no custom function.
  cost_element_glob  TEXT,
  document_type_glob TEXT,
  cost_type          TEXT NOT NULL
                     CHECK (cost_type IN ('LABOR','MATERIAL','SUBCONTRACT','EQUIPMENT','INDIRECT','OTHER')),
  note               TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX ix_cost_type_rule_priority ON cost_type_rule(is_active, priority, rule_id);

-- The former contents of costTypeFromCode(), now data.
INSERT INTO cost_type_rule (priority, cost_element_glob, document_type_glob, cost_type, note) VALUES
  (100, '301*', NULL, 'EQUIPMENT',   'Equipment rent, spares, fuel, in-house plant'),
  (110, '302*', NULL, 'MATERIAL',    'Main and consumable material'),
  (120, '303*', NULL, 'LABOR',       'Salaries and wages'),
  (130, '305*', NULL, 'SUBCONTRACT', 'Subcontractor cost, casual labour'),
  (140, '304*', NULL, 'INDIRECT',    'Site overheads, fees, charges'),
  (150, '306*', NULL, 'INDIRECT',    'Site overheads, fees, charges'),
  (160, '307*', NULL, 'INDIRECT',    'Site overheads, fees, charges'),
  (900, '3*',   NULL, 'OTHER',       'Any other expense account');

-- -----------------------------------------------------------------------------
-- Release the values the old importer baked into the dimension.
--
-- A stored cost_type that equals what the old ranges would have produced came
-- from those ranges, and the seeded rules now reproduce it identically — so
-- clearing it changes nothing while letting rules take effect. A stored value
-- that DIFFERS from the legacy inference can only have been stated by the source
-- file, and that still outranks a rule, so it is kept.
-- -----------------------------------------------------------------------------
UPDATE dim_cost_element
SET cost_type = NULL
WHERE cost_type IS NOT NULL
  AND cost_type = CASE
        WHEN cost_element_code GLOB '301*' THEN 'EQUIPMENT'
        WHEN cost_element_code GLOB '302*' THEN 'MATERIAL'
        WHEN cost_element_code GLOB '303*' THEN 'LABOR'
        WHEN cost_element_code GLOB '305*' THEN 'SUBCONTRACT'
        WHEN cost_element_code GLOB '304*' THEN 'INDIRECT'
        WHEN cost_element_code GLOB '306*' THEN 'INDIRECT'
        WHEN cost_element_code GLOB '307*' THEN 'INDIRECT'
        WHEN cost_element_code GLOB '3*'   THEN 'OTHER'
      END;

-- -----------------------------------------------------------------------------
-- Views resolve cost type per posting row.
--
-- Precedence is unchanged from the importer it replaces:
--   revenue has no cost type  →  a value stated by the file (unless the vague
--   'OTHER')  →  the first matching rule  →  whatever the dimension still holds.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- A service line is a sub-ledger row, not a posting: it has no document type.
-- Only document-type-agnostic rules can apply to it, which keeps the PO
-- reconciliation comparing like with like against v_actual.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_service_line;

CREATE VIEW v_service_line AS
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
