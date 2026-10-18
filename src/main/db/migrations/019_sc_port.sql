-- =============================================================================
-- Subcontract report port (docs/port/sc-gap.md P1-1, P1-3, P1-9; PLAN.md
-- decisions 2 and 3). The tool's rules, as columns of the service-line views.
--
--  * Cut-off: v_service_line is held to project_cutoff the way 018 holds
--    v_posting. Nothing is dropped — a line that is not approved, has no date
--    or is dated after the cut-off stays a row but gets pend_reason and
--    bucket = 'PENDING'. v_service_line_all is the same without the cut-off.
--  * Line rules follow the standalone tool: Normal only within max(1, 0.1%) of
--    qty x net rate; an Adjustment is reported at amount / the rate its PO
--    line was certified at (window over po, item, package, line on Normal
--    lines), else its own net rate.
--  * certificate_id = PO | invoice serial; service_text_norm = the tool's
--    normText, in SQL; tow = Type of Works of the PO (ZSCSRV1).
--  * report_month = month of the project cut-off, else the latest counted
--    month. report_bucket: OPENING / PREVIOUS / THIS_MONTH / PENDING.
--
-- Structure (so the two public views cannot drift apart):
--   v_service_line_core  everything that does not depend on the cut-off
--   v_service_line_all   core + pend_reason / bucket / report_* with NO cut
--   v_service_line       core + the same, held to the project cut-off
-- `bucket` keeps its old meaning (PENDING / OPENING / period_key).
-- =============================================================================

-- A line with no certificate date used to take the batch's period. It is now
-- undated (period_key NULL) so it can be reported as Pending 'No date'.
UPDATE fact_service_line
   SET period_key = NULL
 WHERE invoice_date_key IS NULL
   AND period_key IS NOT NULL
   AND period_key = (SELECT b.period_key FROM import_batch b
                      WHERE b.import_batch_id = fact_service_line.import_batch_id);

-- A user-chosen order for Type of Works (default order = amount desc).
CREATE TABLE dim_tow_order (
  project_key INTEGER NOT NULL REFERENCES dim_project(project_key),
  tow         TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL,
  PRIMARY KEY (project_key, tow)
);

DROP VIEW IF EXISTS v_service_line_po_match;
DROP VIEW IF EXISTS v_service_line;

CREATE VIEW v_service_line_core AS
SELECT
  u.*,
  CASE WHEN u.line_class = 'Adjustment' THEN COALESCE(NULLIF(u.po_line_rate, 0), NULLIF(u.net_rate, 0)) END AS rate_used,
  CASE WHEN u.line_class = 'Adjustment'
       THEN CASE WHEN COALESCE(u.po_line_rate, 0) <> 0 THEN 'PO line' ELSE 'Own price' END END AS rate_src,
  CASE
    WHEN u.line_class = 'Normal' THEN u.q
    WHEN u.line_class = 'Qty only' THEN 0
    WHEN u.a = 0 THEN 0
    ELSE CASE WHEN COALESCE(NULLIF(u.po_line_rate, 0), NULLIF(u.net_rate, 0)) IS NOT NULL
              THEN u.a / COALESCE(NULLIF(u.po_line_rate, 0), NULLIF(u.net_rate, 0))
              ELSE u.q END
  END AS report_qty,
  CASE WHEN u.line_class = 'Adjustment' THEN 1 ELSE 0 END AS is_equiv_qty
FROM (
  SELECT
    t.*,
    -- rate the PO line was certified at: its Normal lines' amount / qty
    CASE WHEN ABS(SUM(CASE WHEN t.line_class = 'Normal' THEN t.q ELSE 0 END)
                  OVER (PARTITION BY t.project_key, t.po_no, t.item_no, t.package_no, t.line_no)) > 1e-9
         THEN SUM(CASE WHEN t.line_class = 'Normal' THEN t.a ELSE 0 END)
                  OVER (PARTITION BY t.project_key, t.po_no, t.item_no, t.package_no, t.line_no)
              / SUM(CASE WHEN t.line_class = 'Normal' THEN t.q ELSE 0 END)
                  OVER (PARTITION BY t.project_key, t.po_no, t.item_no, t.package_no, t.line_no)
    END AS po_line_rate
  FROM (
    SELECT
      s.*,
      CASE
        WHEN s.a = 0 AND s.q <> 0 THEN 'Qty only'
        WHEN s.a = 0 THEN 'Normal'
        WHEN s.q <> 0 AND ABS(s.a - s.q * COALESCE(s.net_rate, 0)) <= MAX(1, 0.001 * ABS(s.a)) THEN 'Normal'
        ELSE 'Adjustment'
      END AS line_class,
      COALESCE((SELECT tr.label FROM dim_sc_trade tr WHERE tr.code = s.trade), 'UNMAPPED') AS trade_label
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
        COALESCE(f.quantity_current, 0) AS q,
        -- A certificate = PO + invoice serial (the tool's rule); a file without
        -- the serial column falls back to the invoice document number.
        COALESCE(f.po_no,'') || '|' || COALESCE(NULLIF(f.invoice_serial,''), f.invoice_no, '') AS certificate_id,
        -- The tool's normText (coding / grouping key), ported to SQL: Arabic
        -- diacritics and tatweel removed, alef/ta marbuta/ya forms unified,
        -- whitespace collapsed and removed around - + * / ( ), trimmed,
        -- lower-cased. (SQLite lower() is ASCII only; JS lower-cases accented
        -- Latin too — irrelevant for SAP service texts.)
        lower(TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(f.service_text,''), char(1600), ''), char(1611), ''), char(1612), ''), char(1613), ''), char(1614), ''), char(1615), ''), char(1616), ''), char(1617), ''), char(1618), ''), char(1571), char(1575)), char(1573), char(1575)), char(1570), char(1575)), char(1577), char(1607)), char(1609), char(1610)), char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' '), char(160), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), ' -', '-'), '- ', '-'), ' +', '+'), '+ ', '+'), ' *', '*'), '* ', '*'), ' /', '/'), '/ ', '/'), ' (', '('), '( ', '('), ' )', ')'), ') ', ')'), ' ')) AS service_text_norm,
        COALESCE(tw.works_type, '(no type of works)') AS tow,
        -- the date the cut-off is judged on: the certificate date, else the
        -- end of an explicitly mapped period; NULL = undated
        CASE
          WHEN f.invoice_date_key IS NOT NULL THEN
            printf('%04d-%02d-%02d', f.invoice_date_key / 10000, (f.invoice_date_key / 100) % 100, f.invoice_date_key % 100)
          WHEN f.period_key IS NOT NULL THEN (SELECT dp.end_date FROM dim_period dp WHERE dp.period_key = f.period_key)
        END AS eff_date,
        pc.cutoff_date
      FROM fact_service_line f
      JOIN import_batch b ON b.import_batch_id = f.import_batch_id
      JOIN report_definition rd ON rd.report_definition_id = b.report_definition_id
      JOIN dim_project p  ON p.project_key = f.project_key
      LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
      LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
      LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
      LEFT JOIN dim_tax_code tx ON tx.code = f.tax_code
      LEFT JOIN project_cutoff pc ON pc.project_key = f.project_key
      -- the PO's Type of Works: the first non-empty one on its ZSCSRV1 lines
      LEFT JOIN (
        SELECT project_key, po_no, works_type FROM (
          SELECT project_key, po_no, TRIM(works_type) AS works_type,
                 ROW_NUMBER() OVER (PARTITION BY project_key, po_no ORDER BY po_service_line_id) AS rn
          FROM v_po_service_line WHERE NULLIF(TRIM(works_type), '') IS NOT NULL)
        WHERE rn = 1
      ) tw ON tw.project_key = f.project_key AND tw.po_no = f.po_no
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
    ) s
  ) t
) u;

-- No cut-off: every approved, dated line counts. report_month = latest counted month.
CREATE VIEW v_service_line_all AS
SELECT
  m.*,
  CASE WHEN m.pend_reason IS NOT NULL THEN 'PENDING'
       WHEN m.is_opening = 1 THEN 'OPENING'
       ELSE m.period_key END AS bucket,
  CASE WHEN m.pend_reason IS NOT NULL THEN 'PENDING'
       WHEN m.is_opening = 1 THEN 'OPENING'
       WHEN m.period_key < m.report_month THEN 'PREVIOUS'
       ELSE 'THIS_MONTH' END AS report_bucket
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

-- The reporting view: held to the project's cut-off (month of the cut-off is the report month).
CREATE VIEW v_service_line AS
SELECT
  m.*,
  CASE WHEN m.pend_reason IS NOT NULL THEN 'PENDING'
       WHEN m.is_opening = 1 THEN 'OPENING'
       ELSE m.period_key END AS bucket,
  CASE WHEN m.pend_reason IS NOT NULL THEN 'PENDING'
       WHEN m.is_opening = 1 THEN 'OPENING'
       WHEN m.period_key < m.report_month THEN 'PREVIOUS'
       ELSE 'THIS_MONTH' END AS report_bucket
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

-- Unchanged from 017_subcontract_report.sql.
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
