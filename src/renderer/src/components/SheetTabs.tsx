import { useState, type ReactNode } from 'react';

export interface Sheet {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * An Excel-worksheet-style switcher: every sheet's data is already fetched by
 * the caller up front (same as the stacked-cards layout this replaces) — this
 * component only controls which one is visible, so switching tabs never
 * re-queries anything.
 */
export function SheetTabs({ sheets }: { sheets: Sheet[] }) {
  const [active, setActive] = useState(sheets[0]?.id);
  const current = sheets.find((s) => s.id === active) ?? sheets[0];

  return (
    <div className="sheet-tabs">
      <div className="sheet-tabs-strip">
        {sheets.map((s) => (
          <button key={s.id} className={active === s.id ? 'on' : ''} onClick={() => setActive(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <div style={{ paddingTop: 14 }}>{current?.content}</div>
    </div>
  );
}
