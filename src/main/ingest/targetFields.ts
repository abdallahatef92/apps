import type { Module, TargetField } from '../../shared/types';

/**
 * Canonical fields each module can be fed. `synonyms` drive the automatic
 * column-mapping suggestion — they are matched loosely (case, spaces and
 * punctuation ignored) against the header text found in the file, and cover the
 * usual SAP export captions as well as the wording cost engineers tend to use.
 */
interface FieldDef extends TargetField {
  synonyms: string[];
}

const COMMON_DIMS: FieldDef[] = [
  { field: 'project_code', label: 'Project code', type: 'text', required: true,
    description: 'Project / WBS root. May also be supplied once for the whole file.',
    synonyms: ['project', 'project code', 'project definition', 'proj', 'projectno',
      'project number', 'pd', 'profit ctr', 'profit center', 'profit centre'] },
  { field: 'wbs_code', label: 'WBS code', type: 'text', required: true,
    description: 'Cost breakdown element the amount belongs to.',
    // Order matters: the first synonym that matches wins. A CJI3 export has both
    // "WBS Element" and "Object"; the former is the one that is only ever a WBS.
    synonyms: ['wbs element', 'wbs code', 'wbs', 'cbs', 'cost object', 'object',
      'activity', 'control account', 'ca'] },
  { field: 'wbs_name', label: 'WBS description', type: 'text', required: false,
    description: 'Used to create the WBS member if it is new.',
    synonyms: ['wbs description', 'wbs name', 'object name', 'description of wbs', 'element name'] },
  { field: 'discipline', label: 'Discipline', type: 'text', required: false,
    description: 'Civil / mechanical / electrical …',
    synonyms: ['discipline', 'trade', 'area'] },
  { field: 'package', label: 'Package', type: 'text', required: false,
    description: 'Work / contract package.',
    synonyms: ['package', 'work package', 'wp', 'contract package'] },
  { field: 'csi_code', label: 'CSI code', type: 'text', required: false,
    description: 'CSI / standard classification code.',
    // Deliberately no bare "class": SAP's "Partner Object Class" column contains it
    // and would be mis-claimed for a settlement's receiver class, not a CSI code.
    synonyms: ['csi', 'csi code', 'classification'] },
  { field: 'cost_element_code', label: 'Cost element', type: 'text', required: false,
    description: 'SAP cost element / GL account.',
    synonyms: ['cost element', 'cost elem', 'gl account', 'g/l account', 'g/l acct',
      'gl acct', 'account', 'account no', 'ce'] },
  { field: 'cost_element_name', label: 'Cost element name', type: 'text', required: false,
    description: 'Description of the cost element.',
    synonyms: ['cost element name', 'cost element descr.', 'cost element description',
      'account name', 'account description', 'name of account'] },
  { field: 'cost_type', label: 'Cost type', type: 'text', required: false,
    description: 'LABOR / MATERIAL / SUBCONTRACT / EQUIPMENT / INDIRECT.',
    // Deliberately no bare "type": SAP's "Object Type" column matches it and
    // carries "WBS", which would classify every cost element as OTHER.
    synonyms: ['cost type', 'resource type', 'cost category'] },
];

const ACTUAL_FIELDS: FieldDef[] = [
  ...COMMON_DIMS,
  { field: 'vendor_code', label: 'Vendor code', type: 'text', required: false,
    description: 'Supplier / subcontractor number.',
    synonyms: ['vendor', 'vendor code', 'supplier', 'supplier code', 'creditor',
      'offsetting account'] },
  { field: 'vendor_name', label: 'Vendor name', type: 'text', required: false,
    description: 'Supplier name, often the offsetting account text in SAP.',
    synonyms: ['vendor name', 'supplier name', 'name of offsetting account', 'offsetting account name', 'partner'] },
  { field: 'period_key', label: 'Period (YYYY-MM)', type: 'period', required: false,
    description: 'Posting period. If absent it is derived from the posting date.',
    synonyms: ['period', 'posting period', 'fiscal period', 'month', 'yearmonth', 'year month'] },
  { field: 'posting_date', label: 'Posting date', type: 'date', required: false,
    description: 'SAP posting date; also used to derive the period.',
    synonyms: ['posting date', 'pstng date', 'post date', 'date', 'gl date'] },
  { field: 'document_date', label: 'Document date', type: 'date', required: false,
    description: 'Date on the source document.',
    synonyms: ['document date', 'doc date', 'invoice date'] },
  { field: 'document_no', label: 'Document number', type: 'text', required: false,
    description: 'SAP CO document number. Part of the line identity that stops a re-import duplicating.',
    synonyms: ['document no', 'document number', 'doc no', 'docno', 'ref document', 'reference'] },
  { field: 'document_line', label: 'Posting row', type: 'text', required: false,
    description: 'Line number within the document. Together with the document number and fiscal '
      + 'year this identifies the posting uniquely, so re-importing replaces rather than adds.',
    synonyms: ['posting row', 'document line', 'line item', 'buzei', 'item no', 'row'] },
  { field: 'fiscal_year', label: 'Fiscal year', type: 'text', required: false,
    description: 'Fiscal year of the posting. Completes the line identity — document numbers '
      + 'restart each year.',
    synonyms: ['fiscal year', 'gjahr', 'year'] },
  { field: 'document_type', label: 'Document type', type: 'text', required: false,
    description: 'SAP document type (RE, KR, SA, RV …).',
    synonyms: ['document type', 'doc type', 'dtype', 'cotype', 'co document type'] },
  { field: 'reference_no', label: 'Reference document', type: 'text', required: false,
    description: 'Reference / material document number.',
    synonyms: ['ref. document number', 'reference document', 'reference key', 'ref doc'] },
  { field: 'po_no', label: 'Purchase order', type: 'text', required: false,
    description: 'Purchasing document. This is what links a posting to its subcontractor service lines.',
    synonyms: ['purchasing document', 'purchase order', 'po', 'po no', 'pur. doc.', 'ebeln'] },
  { field: 'partner_object_type', label: 'Partner object type', type: 'text', required: false,
    description: 'What kind of object this posting settles into (e.g. "Order" for an internal order '
      + 'settlement). Blank for an ordinary posting.',
    synonyms: ['partner object type'] },
  { field: 'partner_object', label: 'Partner object', type: 'text', required: false,
    description: 'The settlement receiver\'s own number — an internal order number when the partner '
      + 'object type is "Order". This is what will link a settlement posting to its own detail report, '
      + 'the way a purchase order links to subcontractor service lines.',
    synonyms: ['partner object'] },
  { field: 'partner_object_name', label: 'Partner object description', type: 'text', required: false,
    description: 'Free text describing the settlement, e.g. the timesheet or period it covers.',
    synonyms: ['partner object name', 'partner obj. name'] },
  { field: 'description', label: 'Line description', type: 'text', required: false,
    description: 'Posting text.',
    synonyms: ['description', 'text', 'posting text', 'item text', 'narrative', 'remarks'] },
  { field: 'quantity', label: 'Quantity', type: 'number', required: false,
    description: 'Quantity posted.',
    synonyms: ['quantity', 'qty', 'total quantity', 'consumed qty'] },
  { field: 'uom', label: 'Unit of measure', type: 'text', required: false,
    description: 'Unit for the quantity.',
    synonyms: ['uom', 'unit', 'unit of measure', 'posted unit of meas.', 'base unit',
      'meins', 'bun', 'oun'] },
  { field: 'amount', label: 'Actual amount', type: 'number', required: true,
    description: 'Actual cost in project currency. Credits should be negative.',
    synonyms: ['amount', 'actual', 'actual cost', 'actual amount', 'value', 'total value',
      'val/coarea crcy', 'val in rep cur', 'amount in local currency', 'cost', 'ac'] },
  { field: 'currency_code', label: 'Currency', type: 'text', required: false,
    description: 'ISO currency of the amount.',
    synonyms: ['currency', 'curr', 'crcy', 'coarea currency'] },
];

const BUDGET_FIELDS: FieldDef[] = [
  ...COMMON_DIMS,
  { field: 'work_package', label: 'Work package code', type: 'text', required: false,
    description: 'The budget\'s own work-package / cost code (e.g. "S.03"), distinct from the '
      + 'WBS-level "Package" field above. Created automatically if it is not already defined.',
    // Deliberately not bare "package" — COMMON_DIMS' own package field already claims that
    // for dim_wbs.package, an unrelated free-text WBS attribute.
    synonyms: ['cost code', 'work package code', 'package code'] },
  { field: 'period_key', label: 'Period (YYYY-MM)', type: 'period', required: false,
    description: 'Only for a time-phased budget. Leave unmapped for a lump-sum budget.',
    synonyms: ['period', 'month', 'yearmonth', 'fiscal period'] },
  { field: 'budget_quantity', label: 'Budget quantity', type: 'number', required: false,
    description: 'Budgeted quantity.',
    synonyms: ['quantity', 'qty', 'budget qty', 'budget quantity', 'boq qty'] },
  { field: 'uom', label: 'Unit of measure', type: 'text', required: false,
    description: 'Unit for the budgeted quantity.',
    synonyms: ['uom', 'unit', 'unit of measure'] },
  { field: 'unit_rate', label: 'Unit rate', type: 'number', required: false,
    description: 'Budgeted rate per unit.',
    synonyms: ['rate', 'unit rate', 'unit price', 'price'] },
  { field: 'budget_amount', label: 'Budget amount', type: 'number', required: true,
    description: 'Budget value in project currency.',
    synonyms: ['budget', 'budget amount', 'budget cost', 'bac', 'original budget',
      'approved budget', 'total budget', 'amount', 'value'] },
  { field: 'description', label: 'Description', type: 'text', required: false,
    description: 'Free text.',
    synonyms: ['description', 'text', 'remarks', 'scope'] },
  { field: 'currency_code', label: 'Currency', type: 'text', required: false,
    description: 'ISO currency of the amount.',
    synonyms: ['currency', 'curr', 'crcy'] },
];

const FORECAST_FIELDS: FieldDef[] = [
  ...COMMON_DIMS,
  { field: 'period_key', label: 'Period (YYYY-MM)', type: 'period', required: false,
    description: 'Period the forecast spend falls in.',
    synonyms: ['period', 'month', 'yearmonth', 'fiscal period'] },
  { field: 'forecast_amount', label: 'Forecast amount', type: 'number', required: true,
    description: 'Planned spend in this period (time-phased ETC).',
    synonyms: ['forecast', 'forecast amount', 'forecast cost', 'planned', 'planned cost', 'etc by period'] },
  { field: 'etc_amount', label: 'ETC', type: 'number', required: false,
    description: 'Estimate to complete.',
    synonyms: ['etc', 'estimate to complete', 'remaining cost', 'to complete', 'rtc'] },
  { field: 'eac_amount', label: 'EAC', type: 'number', required: false,
    description: 'Estimate at completion.',
    synonyms: ['eac', 'estimate at completion', 'final cost', 'fac', 'forecast final cost'] },
  { field: 'committed_amount', label: 'Committed', type: 'number', required: false,
    description: 'Committed / PO value not yet actualised.',
    synonyms: ['committed', 'commitment', 'po value', 'purchase order', 'obligated'] },
  { field: 'forecast_method', label: 'Forecast method', type: 'text', required: false,
    description: 'How the number was produced (MANUAL, CPI, REMAINING_BUDGET …).',
    synonyms: ['method', 'forecast method', 'basis'] },
  { field: 'description', label: 'Description', type: 'text', required: false,
    description: 'Free text.',
    synonyms: ['description', 'text', 'remarks', 'justification'] },
  { field: 'currency_code', label: 'Currency', type: 'text', required: false,
    description: 'ISO currency of the amount.',
    synonyms: ['currency', 'curr', 'crcy'] },
];


/**
 * Subcontractor service lines. These sit beneath a PO that is already posted in
 * CJI3, so they are reconciliation and drill-down detail — never actual cost.
 */
const SERVICE_FIELDS: FieldDef[] = [
  { field: 'project_code', label: 'Project code', type: 'text', required: false,
    description: 'Project. Often the profit centre on a subcontract report.',
    synonyms: ['project', 'project code', 'project definition', 'profit ctr', 'profit center'] },
  { field: 'wbs_code', label: 'WBS code', type: 'text', required: true,
    description: 'WBS the service line is charged to.',
    synonyms: ['wbs', 'wbs element', 'wbs code'] },
  { field: 'cost_element_code', label: 'Cost element / GL', type: 'text', required: false,
    description: 'The account the line posts to; matches the cost element in CJI3.',
    synonyms: ['g/l acct', 'gl acct', 'g/l account', 'gl account', 'cost element', 'account'] },
  { field: 'po_no', label: 'Purchase order', type: 'text', required: true,
    description: 'Purchasing document. The join back to the actual posting.',
    synonyms: ['pur. doc.', 'purchasing document', 'purchase order', 'po', 'po no'] },
  { field: 'invoice_no', label: 'Invoice document', type: 'text', required: false,
    description: 'SAP invoice / payment certificate document number.',
    synonyms: ['documentno', 'document no', 'invoice no', 'invoice number', 'document number'] },
  { field: 'entry_sheet_no', label: 'Service entry sheet', type: 'text', required: false,
    description: 'Service entry sheet number.',
    synonyms: ['entry sh.', 'entry sheet', 'service entry sheet', 'ses'] },
  { field: 'invoice_serial', label: 'Certificate serial', type: 'text', required: false,
    description: 'Interim payment certificate serial, e.g. C1.',
    synonyms: ['invoice serial (new)', 'invoice serial', 'certificate', 'ipc', 'serial'] },
  { field: 'invoice_date', label: 'Certificate date', type: 'date', required: false,
    description: 'Date of the certificate; also derives the period.',
    synonyms: ['date', 'doc. date', 'document date', 'invoice date'] },
  { field: 'vendor_code', label: 'Supplier code', type: 'text', required: false,
    description: 'Supplier number.',
    synonyms: ['supplier', 'vendor', 'supplier code', 'vendor code'] },
  // The caption below genuinely holds the supplier NAME in the SAP subcontractor
  // report — the two supplier columns are labelled the wrong way round. The
  // mapping screen shows sample values, so a report that labels them correctly is
  // easy to spot and correct.
  { field: 'vendor_name', label: 'Supplier name', type: 'text', required: false,
    description: 'Supplier name.',
    synonyms: ['account number of supplier', 'supplier name', 'vendor name', 'searchterm'] },
  { field: 'item_no', label: 'Item', type: 'text', required: false,
    description: 'PO item number.', synonyms: ['item', 'item no', 'po item'] },
  { field: 'line_no', label: 'Line', type: 'text', required: false,
    description: 'Service line number within the item.', synonyms: ['line', 'line no', 'sc serial'] },
  { field: 'service_code', label: 'Service code', type: 'text', required: false,
    description: 'Service master number, e.g. S0302.', synonyms: ['service', 'service code', 'activity number'] },
  { field: 'service_text', label: 'Service description', type: 'text', required: false,
    description: 'Short text of the service line.',
    synonyms: ['short text 1', 'short text', 'service description', 'description of service'] },
  { field: 'category', label: 'Category', type: 'text', required: false,
    description: 'Work category, e.g. "DIV03 - CONCRETE" or "Equipment Rent".',
    synonyms: ['description', 'category', 'div', 'trade'] },
  { field: 'contract_type', label: 'Contract type', type: 'text', required: false,
    description: 'Contract type code carried on the certificate.',
    synonyms: ['contract type', 'tx', 'type of contract'] },
  { field: 'unit_rate', label: 'Unit rate', type: 'number', required: false,
    description: 'Agreed rate per unit.', synonyms: ['gross price', 'unit rate', 'rate', 'price'] },
  { field: 'uom', label: 'Unit', type: 'text', required: false,
    description: 'Unit of measure.', synonyms: ['bun', 'oun', 'uom', 'unit'] },
  { field: 'quantity_total', label: 'Quantity to date', type: 'number', required: false,
    description: 'Cumulative quantity certified.', synonyms: ['total quantity', 'quantity to date', 'cumulative qty'] },
  { field: 'quantity_previous', label: 'Quantity previous', type: 'number', required: false,
    description: 'Quantity certified in earlier certificates.', synonyms: ['previous quantity', 'prev quantity'] },
  { field: 'quantity_current', label: 'Quantity this period', type: 'number', required: false,
    description: 'Quantity certified on this certificate.', synonyms: ['current quantity', 'quantity current'] },
  { field: 'progress_pct', label: 'Progress %', type: 'number', required: false,
    description: 'Percent complete on the line.', synonyms: ['progress %', 'progress', 'percent complete'] },
  { field: 'amount_net', label: 'Work done (net)', type: 'number', required: true,
    description: 'Value of work certified this period, excluding VAT. This is what reconciles to actual cost.',
    synonyms: ['sc work current cost', 'work current cost', 'net amount', 'net value', 'amount net'] },
  { field: 'amount_vat', label: 'VAT', type: 'number', required: false,
    description: 'VAT on the work certified this period.', synonyms: ['vat current', 'vat', 'tax amount'] },
  { field: 'amount_gross', label: 'Work done (gross)', type: 'number', required: false,
    description: 'Certified value including VAT.',
    synonyms: ['sc work current + vat', 'work current + vat', 'gross amount', 'total incl vat'] },
  { field: 'currency_code', label: 'Currency', type: 'text', required: false,
    description: 'ISO currency.', synonyms: ['crcy', 'currency', 'curr'] },
];

/**
 * WBS master — the project structure export.
 *
 * Note the SAP caption trap this handles: in the standard project structure
 * export "Title" carries the WBS code and "Description" carries its name.
 */
const WBS_MASTER_FIELDS: FieldDef[] = [
  { field: 'wbs_code', label: 'WBS code', type: 'text', required: true,
    description: 'The WBS element identifier. In an SAP structure export this is the "Title" column.',
    synonyms: ['title', 'wbs', 'wbs element', 'wbs code', 'element'] },
  { field: 'wbs_name', label: 'WBS description', type: 'text', required: false,
    description: 'The name of the element — the "Description" column in an SAP structure export.',
    synonyms: ['description', 'wbs description', 'wbs name', 'object name', 'short description'] },
  { field: 'wbs_level', label: 'Level', type: 'number', required: false,
    description: 'Hierarchy level. Used with row order to rebuild parent/child links.',
    synonyms: ['level', 'wbs level', 'lvl', 'stufe'] },
  { field: 'planned_start', label: 'Planned start', type: 'date', required: false,
    description: 'Basic start date.', synonyms: ['start date', 'basic start', 'planned start'] },
  { field: 'planned_finish', label: 'Planned finish', type: 'date', required: false,
    description: 'Basic finish date.', synonyms: ['basic fin.', 'basic finish', 'finish date', 'planned finish'] },
  { field: 'actual_start', label: 'Actual start', type: 'date', required: false,
    description: 'Actual start date.', synonyms: ['act. start', 'actual start'] },
  { field: 'actual_finish', label: 'Actual finish', type: 'date', required: false,
    description: 'Actual finish date.', synonyms: ['actual end', 'act. finish', 'actual finish'] },
  { field: 'discipline', label: 'Discipline', type: 'text', required: false,
    description: 'Optional discipline tag.', synonyms: ['discipline', 'trade', 'area'] },
  { field: 'package', label: 'Package', type: 'text', required: false,
    description: 'Optional work package tag.', synonyms: ['package', 'work package'] },
];

/**
 * Order settlement detail — CO line items posted to an internal order rather
 * than a WBS. No column identifies a line uniquely, so unlike ACTUAL/SERVICE
 * there is no natural-key field here at all; re-imports fall back to batch
 * superseding, the same as budget, forecast and master data.
 */
const ORDER_FIELDS: FieldDef[] = [
  ...COMMON_DIMS,
  { field: 'order_no', label: 'Order', type: 'text', required: true,
    description: 'Internal order number. This is what links a line to the settlement posting CJI3 '
      + 'carries under Partner Object.',
    synonyms: ['order'] },
  { field: 'order_description', label: 'Order description', type: 'text', required: false,
    description: 'Free text on the order.',
    synonyms: ['order description'] },
  { field: 'order_type', label: 'Order type', type: 'text', required: false,
    description: 'SAP order type (e.g. a fuel charging order, a repair order).',
    synonyms: ['order type'] },
  { field: 'category', label: 'Settlement category', type: 'text', required: false,
    description: '"WBS" once this line has settled onto a project element; "CTR" while it still '
      + 'sits on a cost centre and has not reached any project yet.',
    synonyms: ['category'] },
  { field: 'cost_center_code', label: 'Cost centre', type: 'text', required: false,
    description: 'Cost centre currently holding the cost, for a line not yet settled to a WBS.',
    synonyms: ['cost center', 'cost centre'] },
  { field: 'cost_center_name', label: 'Cost centre description', type: 'text', required: false,
    description: 'Name of the cost centre.',
    synonyms: ['cost center description', 'cost centre description'] },
  { field: 'vendor_code', label: 'Business partner', type: 'text', required: false,
    description: 'Vendor / business partner on the line.',
    synonyms: ['business partner'] },
  { field: 'vendor_name', label: 'Business partner name', type: 'text', required: false,
    description: 'Business partner description.',
    synonyms: ['business partner de', 'business partner description'] },
  { field: 'po_no', label: 'Purchase order', type: 'text', required: false,
    description: 'Purchase order behind the line, when there is one. Not the join key for this '
      + 'report — order_no is.',
    synonyms: ['po', 'purchasing document', 'purchase order'] },
  { field: 'fiscal_year', label: 'Fiscal year', type: 'text', required: false,
    description: 'Combined with the posting month to build the period.',
    synonyms: ['year', 'fiscal year'] },
  { field: 'period_month', label: 'Posting month', type: 'text', required: false,
    description: 'Numeric posting month (1-12). Combined with the fiscal year to build the period, '
      + 'since this report gives no single period column.',
    synonyms: ['month'] },
  { field: 'quantity', label: 'Quantity', type: 'number', required: false,
    description: 'Quantity posted.',
    synonyms: ['total qty', 'quantity', 'qty'] },
  { field: 'uom', label: 'Unit of measure', type: 'text', required: false,
    description: 'Unit for the quantity.',
    synonyms: ['activity type uom', 'uom', 'unit of measure'] },
  { field: 'amount', label: 'Actual amount', type: 'number', required: true,
    description: 'Actual cost on the order line.',
    synonyms: ['actual', 'amount', 'value'] },
  { field: 'currency_code', label: 'Currency', type: 'text', required: false,
    description: 'ISO currency of the amount.',
    synonyms: ['currency', 'curr', 'crcy'] },
];

const ACCRUAL_FIELDS: FieldDef[] = [
  ...COMMON_DIMS,
  { field: 'period_key', label: 'Period (YYYY-MM)', type: 'period', required: false,
    description: 'Period the accrual applies to.',
    synonyms: ['period', 'month', 'yearmonth', 'fiscal period'] },
  { field: 'accrual_type', label: 'Accrual type', type: 'text', required: false,
    description: 'Free text, e.g. ADD/OMM, Provision.',
    synonyms: ['accrual type', 'type', 'provision type', 'add/omm'] },
  { field: 'amount', label: 'Accrual amount', type: 'number', required: true,
    description: 'Estimated cost not yet posted in SAP.',
    synonyms: ['accrual', 'accrual amount', 'accrued cost', 'provision', 'provision amount', 'amount', 'value'] },
  { field: 'description', label: 'Description', type: 'text', required: false,
    description: 'Free text.',
    synonyms: ['description', 'text', 'remarks'] },
  { field: 'currency_code', label: 'Currency', type: 'text', required: false,
    description: 'ISO currency of the amount.',
    synonyms: ['currency', 'curr', 'crcy'] },
];

const BY_MODULE: Record<string, FieldDef[]> = {
  ACTUAL: ACTUAL_FIELDS,
  BUDGET: BUDGET_FIELDS,
  FORECAST: FORECAST_FIELDS,
  COMMITMENT: ACTUAL_FIELDS,
  SERVICE: SERVICE_FIELDS,
  MASTER: WBS_MASTER_FIELDS,
  ORDER: ORDER_FIELDS,
  ACCRUAL: ACCRUAL_FIELDS,
};

export function targetFields(module: Module): TargetField[] {
  return (BY_MODULE[module] ?? []).map(({ synonyms: _s, ...f }) => f);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Suggest a source column for each target field.
 *
 * Scoring, highest first:
 *   - an exact match on the field name, its label, or a synonym
 *   - a column whose caption *contains* a synonym ("CO Object Name" ⊃ "object name")
 *
 * Earlier synonyms outrank later ones, so a field can express a preference between
 * two columns that both match — which is how "WBS Element" beats "Object" in a
 * CJI3 export. Containment is one-directional on purpose: a short generic caption
 * like "Name" must not claim a field whose synonym merely contains it.
 *
 * Each source column is used at most once, best score first.
 */
export function suggestMapping(module: Module, columns: string[]): Record<string, string> {
  const fields = BY_MODULE[module] ?? [];
  const normalisedCols = columns
    .map((c) => ({ raw: c, n: norm(c) }))
    .filter((c) => c.n.length > 0);

  const scored: { field: string; column: string; score: number }[] = [];
  for (const f of fields) {
    const targets = [f.field, f.label, ...f.synonyms].map(norm);
    for (const col of normalisedCols) {
      const exact = targets.indexOf(col.n);
      let score = 0;
      if (exact >= 0) {
        score = 100 - exact;
      } else {
        const contains = targets.findIndex((t) => t.length > 3 && col.n.includes(t));
        if (contains >= 0) score = 50 - contains;
      }
      if (score > 0) scored.push({ field: f.field, column: col.raw, score: score + (f.required ? 200 : 0) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const usedCols = new Set<string>();
  const result: Record<string, string> = {};
  for (const s of scored) {
    if (result[s.field] || usedCols.has(s.column)) continue;
    result[s.field] = s.column;
    usedCols.add(s.column);
  }
  return result;
}
