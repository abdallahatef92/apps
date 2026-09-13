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
    synonyms: ['project', 'project code', 'project definition', 'proj', 'projectno', 'project number', 'pd'] },
  { field: 'wbs_code', label: 'WBS code', type: 'text', required: true,
    description: 'Cost breakdown element the amount belongs to.',
    synonyms: ['wbs', 'wbs element', 'wbs code', 'object', 'cbs', 'cost object', 'activity', 'control account', 'ca'] },
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
    synonyms: ['csi', 'csi code', 'class', 'classification'] },
  { field: 'cost_element_code', label: 'Cost element', type: 'text', required: false,
    description: 'SAP cost element / GL account.',
    synonyms: ['cost element', 'cost elem', 'gl account', 'g/l account', 'account', 'account no', 'ce'] },
  { field: 'cost_element_name', label: 'Cost element name', type: 'text', required: false,
    description: 'Description of the cost element.',
    synonyms: ['cost element name', 'cost element description', 'account name', 'account description', 'name of account'] },
  { field: 'cost_type', label: 'Cost type', type: 'text', required: false,
    description: 'LABOR / MATERIAL / SUBCONTRACT / EQUIPMENT / INDIRECT.',
    synonyms: ['cost type', 'type', 'resource type', 'category'] },
];

const ACTUAL_FIELDS: FieldDef[] = [
  ...COMMON_DIMS,
  { field: 'vendor_code', label: 'Vendor code', type: 'text', required: false,
    description: 'Supplier / subcontractor number.',
    synonyms: ['vendor', 'vendor code', 'supplier', 'supplier code', 'creditor'] },
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
    description: 'SAP document / reference number.',
    synonyms: ['document no', 'document number', 'doc no', 'docno', 'ref document', 'reference'] },
  { field: 'document_type', label: 'Document type', type: 'text', required: false,
    description: 'SAP document type (RE, KR, SA …).',
    synonyms: ['document type', 'doc type', 'dtype', 'cotype', 'co document type'] },
  { field: 'description', label: 'Line description', type: 'text', required: false,
    description: 'Posting text.',
    synonyms: ['description', 'text', 'posting text', 'item text', 'narrative', 'remarks'] },
  { field: 'quantity', label: 'Quantity', type: 'number', required: false,
    description: 'Quantity posted.',
    synonyms: ['quantity', 'qty', 'total quantity', 'consumed qty'] },
  { field: 'uom', label: 'Unit of measure', type: 'text', required: false,
    description: 'Unit for the quantity.',
    synonyms: ['uom', 'unit', 'unit of measure', 'base unit', 'meins'] },
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

const BY_MODULE: Record<string, FieldDef[]> = {
  ACTUAL: ACTUAL_FIELDS,
  BUDGET: BUDGET_FIELDS,
  FORECAST: FORECAST_FIELDS,
  COMMITMENT: ACTUAL_FIELDS,
  MASTER: COMMON_DIMS,
};

export function targetFields(module: Module): TargetField[] {
  return (BY_MODULE[module] ?? []).map(({ synonyms: _s, ...f }) => f);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Suggest a source column for each target field.
 * Exact normalised match wins; then a synonym match; then containment.
 * Each source column is used at most once, best score first.
 */
export function suggestMapping(module: Module, columns: string[]): Record<string, string> {
  const fields = BY_MODULE[module] ?? [];
  const normalisedCols = columns.map((c) => ({ raw: c, n: norm(c) }));

  const scored: { field: string; column: string; score: number }[] = [];
  for (const f of fields) {
    const targets = [f.field, f.label, ...f.synonyms].map(norm);
    for (const col of normalisedCols) {
      let score = 0;
      if (targets.includes(col.n)) {
        score = 100;
      } else if (targets.some((t) => t.length > 3 && (col.n.includes(t) || t.includes(col.n)))) {
        score = 60;
      }
      if (score > 0) scored.push({ field: f.field, column: col.raw, score: score + (f.required ? 5 : 0) });
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
