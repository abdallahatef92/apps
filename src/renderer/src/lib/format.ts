const NUMERIC_HINT = /(amount|budget|actual|forecast|etc|eac|vac|variance|cost|value|qty|quantity|rate|total|cum|overrun|count|rows|days|pct|percent|progress|lines|_no$|_key$)/i;
const PCT_HINT = /(pct|percent|progress)/i;
const KEY_HINT = /(_key$|_id$|row_no|top_n)/i;
/** Columns that are money and therefore always carry decimals, even when whole. */
const MONEY_HINT = /(amount|budget|actual|forecast|etc|eac|vac|variance|cost|value|rate|price|cum|overrun|margin|revenue|vat|net|gross)/i;

export function isNumericColumn(name: string, sample: unknown): boolean {
  if (typeof sample === 'number') return true;
  return NUMERIC_HINT.test(name) && sample !== null && !Number.isNaN(Number(sample));
}

export function formatCell(name: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  if (KEY_HINT.test(name)) return String(value);
  if (PCT_HINT.test(name)) return `${value.toFixed(1)}%`;
  if (MONEY_HINT.test(name)) {
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // A count is a count: no decimals on whole numbers that are not money.
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Compact money for KPI tiles: 12.4M / 850.0K. */
export function money(value: number | null | undefined, currency = ''): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const unit = abs >= 1e9 ? ['B', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e3 ? ['K', 1e3] : ['', 1];
  const n = abs / (unit[1] as number);
  const text = `${sign}${n.toFixed(unit[0] ? 1 : 0)}${unit[0]}`;
  return currency ? `${currency} ${text}` : text;
}

export function pct(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? '—' : `${value.toFixed(1)}%`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function periodOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}
