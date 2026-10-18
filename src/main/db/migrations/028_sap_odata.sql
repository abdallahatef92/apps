-- =============================================================================
-- Actual cost pulled live from S/4HANA over OData (ported from branch
-- ccr-ef4884cd-jzod7f, where it was migration 008).
--
-- A pull is not a new kind of import: it goes through the same staging,
-- validation and line identity as an uploaded CJI3, so it needs only a report
-- definition and a saved column mapping. It is its own report definition, not
-- SAP_CJI3, because the journal entry API is keyed by the FI accounting document
-- and CJI3 by the CO document: the two never share a line_uid, so the same
-- posting loaded from both would count twice. On Home it fills the CJI3 card
-- (build step B04) as an alternative to the file, never on top of it — the pull
-- screen blocks posting while the project has CJI3 cost, and BUILD_CHECKS warns
-- if both end up loaded.
--
-- The mapping uses the property names of API_JOURNALENTRYITEMBASIC_SRV.
-- =============================================================================

INSERT INTO report_definition
  (source_system_id, code, name, module, description, expected_frequency, staleness_days, detail_key_fields)
SELECT source_system_id, 'S4_JOURNAL_ITEMS', 'S/4HANA journal entry items (live)', 'ACTUAL',
       'Pulled from S/4HANA over OData (API_JOURNALENTRYITEMBASIC_SRV), leading ledger only. '
       || 'Keyed by FI document, so do not also load CJI3 for the same project.',
       'WEEKLY', 10, '["document_no"]'
FROM report_definition WHERE code = 'SAP_CJI3';

-- Line identity is document + ledger line item + fiscal year: SAP's own key for a journal entry line.
INSERT INTO column_mapping (report_definition_id, source_column, target_field)
SELECT rd.report_definition_id, m.column1, m.column2
FROM report_definition rd,
     (VALUES ('WBSElement', 'wbs_code'), ('GLAccount', 'cost_element_code'),
             ('AccountingDocument', 'document_no'), ('LedgerGLLineItem', 'document_line'),
             ('FiscalYear', 'fiscal_year'), ('AccountingDocumentType', 'document_type'),
             ('PostingDate', 'posting_date'), ('DocumentDate', 'document_date'),
             ('ReferenceDocument', 'reference_no'), ('PurchasingDocument', 'po_no'),
             ('Supplier', 'vendor_code'), ('DocumentItemText', 'description'),
             ('Quantity', 'quantity'), ('BaseUnit', 'uom'),
             ('AmountInCompanyCodeCurrency', 'amount'), ('CompanyCodeCurrency', 'currency_code')) m
WHERE rd.code = 'S4_JOURNAL_ITEMS';

-- The CJI3 card on Home is filled by either source.
INSERT INTO build_step_report (step_code, report_definition_id)
SELECT 'B04', report_definition_id FROM report_definition WHERE code = 'S4_JOURNAL_ITEMS';
