/** Value coercion shared by staging and posting. Cost reports are messy. */

export function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Parse a number out of anything a cost report might contain:
 * "1,234.56", "1.234,56", "(1,234)", "1234-", "USD 1,234", "12%".
 * Returns null when there is no number at all.
 */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  let s = String(v).trim();
  if (s === '' || s === '-') return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, ''); }

  s = s.replace(/[^\d.,\-]/g, '');
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  s = s.replace(/-/g, '');
  if (s === '') return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal point.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // A single comma: decimal separator unless it looks like a thousands group.
    s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse a date to ISO `YYYY-MM-DD`, or null. Ambiguous d/m defaults to day-first. */
export function toDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);

  // Excel serial date (days since 1899-12-30)
  if (typeof v === 'number' && v > 20000 && v < 60000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  }

  const s = String(v).trim();
  let m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
    const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  m = /^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{2,4})/.exec(s);
  if (m) {
    const month = MONTH_NAMES[m[2].slice(0, 3).toLowerCase()];
    const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (month) return `${yr}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Normalise anything that identifies a month into `YYYY-MM`:
 * "2026-03", "03/2026", "Mar-26", "202603", "3.2026", or a full date.
 */
export function toPeriod(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();

  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;

  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;

  m = /^(\d{4})(0[1-9]|1[0-2])$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;

  m = /^([A-Za-z]{3,})[ -/]?(\d{2,4})$/.exec(s);
  if (m) {
    const month = MONTH_NAMES[m[1].slice(0, 3).toLowerCase()];
    const yr = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    if (month) return `${yr}-${String(month).padStart(2, '0')}`;
  }

  const d = toDate(s);
  return d ? d.slice(0, 7) : null;
}
