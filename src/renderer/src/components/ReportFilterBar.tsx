import { useEffect, useState } from 'react';

export interface FilterOption { value: string; label: string }

export interface FilterDef {
  key: string;
  label: string;
  /** 'select' needs `options`; 'text' is a free-text box committed after a short pause. */
  kind: 'select' | 'text';
  options?: FilterOption[];
  placeholder?: string;
}

/**
 * One row of report filters above a set of tabs: a free-text search and a select per dimension, the active
 * filters as removable chips, and Clear. It only holds presentation state — the page turns `values` into the
 * optional query params, so the filtering itself is SQL.
 */
export function ReportFilterBar({ filters, values, onChange, onClear, busy }: {
  filters: FilterDef[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onClear: () => void;
  busy?: boolean;
}) {
  const active = filters.filter((f) => values[f.key]);
  return (
    <div className="card rpt-filter">
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        {filters.map((f) => (
          <label className="field" key={f.key}>
            <span>{f.label}</span>
            {f.kind === 'text'
              ? <DebouncedInput value={values[f.key] ?? ''} placeholder={f.placeholder} onCommit={(v) => onChange(f.key, v)} />
              : (
                <select value={values[f.key] ?? ''} onChange={(e) => onChange(f.key, e.target.value)}>
                  <option value="">All</option>
                  {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
          </label>
        ))}
        <button className="btn sm" onClick={onClear} disabled={active.length === 0}>Clear</button>
        {busy && <span className="spinner" aria-label="Loading" />}
      </div>
      {active.length > 0 && (
        <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          {active.map((f) => {
            const shown = f.kind === 'select'
              ? (f.options ?? []).find((o) => o.value === values[f.key])?.label ?? values[f.key]
              : `“${values[f.key]}”`;
            return (
              <button key={f.key} className="rpt-chip" onClick={() => onChange(f.key, '')}
                      title={`Remove the ${f.label.toLowerCase()} filter`}>
                <span className="faint">{f.label}</span> {shown} <span aria-hidden>×</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DebouncedInput({ value, placeholder, onCommit }: {
  value: string; placeholder?: string; onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onCommit(draft.trim()), 350);
    return () => clearTimeout(t);
  }, [draft, value, onCommit]);
  return <input value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} />;
}
