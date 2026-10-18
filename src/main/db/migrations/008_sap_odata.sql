-- =============================================================================
-- Actual cost pulled live from S/4HANA over OData.
--
-- A pull is not a new kind of import. It goes through the same staging, the
-- same validation and the same line identity as an uploaded CJI3, which is why
-- all it needs is a report definition and a saved column mapping.
--
-- It is its own report definition, not SAP_CJI3, for a reason that matters:
-- the journal entry API is keyed by the FI accounting document, CJI3 by the CO
-- document. Those are different number ranges, so the two never share a
-- line_uid and the same posting loaded from both would be counted twice. Keeping
-- them apart lets the freshness board date each one, and lets the pull screen
-- warn when a project already has CJI3 cost posted.
--
-- The mapping uses the property names of API_JOURNALENTRYITEMBASIC_SRV. A
-- column SAP does not send simply stays unmapped, and the screen says so.
-- =============================================================================

INSERT INTO report_definition
  (report_definition_id, source_system_id, code, name, module, description,
   expected_frequency, staleness_days, detail_key_fields) VALUES
  (9, 1, 'S4_JOURNAL_ITEMS', 'S/4HANA journal entry items (live)', 'ACTUAL',
   'Pulled from S/4HANA over OData (API_JOURNALENTRYITEMBASIC_SRV), leading ledger only. '
   || 'Keyed by FI document, so do not also load CJI3 for the same project.',
   'WEEKLY', 10, '["document_no"]');

-- Line identity is document + ledger line item + fiscal year: SAP's own key for
-- a journal entry line within one company code.
INSERT INTO column_mapping (report_definition_id, source_column, target_field) VALUES
  (9, 'WBSElement',                  'wbs_code'),
  (9, 'GLAccount',                   'cost_element_code'),
  (9, 'AccountingDocument',          'document_no'),
  (9, 'LedgerGLLineItem',            'document_line'),
  (9, 'FiscalYear',                  'fiscal_year'),
  (9, 'AccountingDocumentType',      'document_type'),
  (9, 'PostingDate',                 'posting_date'),
  (9, 'DocumentDate',                'document_date'),
  (9, 'ReferenceDocument',           'reference_no'),
  (9, 'PurchasingDocument',          'po_no'),
  (9, 'Supplier',                    'vendor_code'),
  (9, 'DocumentItemText',            'description'),
  (9, 'Quantity',                    'quantity'),
  (9, 'BaseUnit',                    'uom'),
  (9, 'AmountInCompanyCodeCurrency', 'amount'),
  (9, 'CompanyCodeCurrency',         'currency_code');
