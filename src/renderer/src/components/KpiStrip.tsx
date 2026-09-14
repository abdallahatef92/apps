import type { QueryResult } from '@shared/types';
import { money } from '../lib/format';
import { Sparkline } from '../charts/Sparkline';

const MONEY = /(budget|cost|revenue|amount|eac|etc|vac|margin|value|vat|net|gross|work_done)/i;
const TONE_GOOD_WHEN_POSITIVE = /(vac|margin|variance|reconciled)/i;
const TONE_BAD = /(differing|overrun|rejected)/i;

/**
 * The headline row for an analysis, rendered from a single-row result produced by
 * a stored query — the numbers are SQL, not sums taken over the table above.
 */
export function KpiStrip({ headline, currency, spark, sparkOn = 'actual_cost' }:
  { headline: QueryResult; currency?: string; spark?: number[]; sparkOn?: string }) {
  const row = headline.rows[0];
  if (!row) return null;

  const cells = headline.columns.filter((c) => c !== 'data_date');

  return (
    <div className="grid k4" style={{ marginBottom: 16 }}>
      {cells.map((c, i) => {
        const raw = row[c];
        // A null measure means "not applicable", not zero — say so.
        const missing = raw === null || raw === undefined;
        const n = typeof raw === 'number' ? raw : Number(raw);
        const isNumber = !missing && Number.isFinite(n);
        const isMoney = MONEY.test(c);
        const tone = !isNumber ? ''
          : TONE_BAD.test(c) ? (n > 0 ? 'bad' : '')
          : TONE_GOOD_WHEN_POSITIVE.test(c) ? (n < 0 ? 'bad' : n > 0 ? 'good' : '')
          : '';

        return (
          <div className="kpi" key={c}
               style={{ ['--kpi-accent' as string]: c === sparkOn ? 'var(--accent)' : 'transparent' }}>
            <div className="label">{c.replace(/_/g, ' ')}</div>
            <div className={`value ${tone}`}>
              {missing ? '—'
                : !isNumber ? String(raw)
                : isMoney ? money(n, currency ?? '')
                : n.toLocaleString()}
            </div>
            {c === sparkOn && spark && spark.length > 1 && (
              <div className="spark"><Sparkline values={spark} /></div>
            )}
          </div>
        );
      })}
    </div>
  );
}
