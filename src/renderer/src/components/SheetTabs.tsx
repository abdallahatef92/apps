import { useState, type ReactNode } from 'react';

export interface Sheet {
  id: string;
  label: string;
  /** A node, or a function called only while this sheet is the open one (lazy content). */
  content: ReactNode | (() => ReactNode);
}

/**
 * An Excel-worksheet-style switcher. Only the open sheet's content is rendered; a sheet whose content is a
 * function is not even built until it is opened. Uncontrolled by default; pass `activeId` + `onActiveChange`
 * when the page needs to know which sheet is open (to fetch its data on first open).
 */
export function SheetTabs({ sheets, activeId, onActiveChange }: {
  sheets: Sheet[];
  activeId?: string;
  onActiveChange?: (id: string) => void;
}) {
  const [inner, setInner] = useState(sheets[0]?.id);
  const active = activeId ?? inner;
  const current = sheets.find((s) => s.id === active) ?? sheets[0];
  const pick = (id: string) => { setInner(id); onActiveChange?.(id); };

  return (
    <div className="sheet-tabs">
      <div className="sheet-tabs-strip">
        {sheets.map((s) => (
          <button key={s.id} className={current?.id === s.id ? 'on' : ''} onClick={() => pick(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <div style={{ paddingTop: 14 }}>
        {typeof current?.content === 'function' ? (current.content as () => ReactNode)() : current?.content}
      </div>
    </div>
  );
}
