import type { SapExtract } from './types';

/**
 * The extract a fresh install starts from: S/4HANA's standard journal entry
 * API. Shared with the renderer so the screen shows exactly the filter the main
 * process will send.
 */
export const DEFAULT_EXTRACT: SapExtract = {
  servicePath: '/sap/opu/odata/sap/API_JOURNALENTRYITEMBASIC_SRV',
  entitySet: 'A_JournalEntryItemBasic',
  wbsPrefix: '',
  postedFrom: null,
  // The leading ledger only: every other ledger repeats the same postings.
  extraFilter: "Ledger eq '0L'",
  wbsField: 'WBSElement',
  dateField: 'PostingDate',
};

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Build the OData $filter. Kept as one plain string the screen also shows, so
 * whoever looks after SAP can read exactly what was asked for.
 */
export function buildFilter(x: SapExtract): string {
  const parts: string[] = [];
  if (x.wbsPrefix.trim()) parts.push(`startswith(${x.wbsField},${quote(x.wbsPrefix.trim())}) eq true`);
  if (x.postedFrom) parts.push(`${x.dateField} ge datetime${quote(`${x.postedFrom}T00:00:00`)}`);
  if (x.extraFilter.trim()) parts.push(`(${x.extraFilter.trim()})`);
  return parts.join(' and ');
}
