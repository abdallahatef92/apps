import type { ReactNode } from 'react';

/**
 * One "At a glance" card, shared by the Subcontractor and Material pages: an uppercase
 * label, the figure, the sentence(s) saying what it means, and an optional jump to where
 * it is fixed.
 * `flagged` puts the card in the warning ink/border (something to act on) -
 * it carries status, never a series colour.
 */
export function InsightCard({ label, figure, flagged, action, children }: {
  label: string;
  figure?: ReactNode;
  flagged?: boolean;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <div className={`glance${flagged ? ' flag' : ''}`}>
      <div className="k">{label}</div>
      {figure !== undefined && <div className="figure">{figure}</div>}
      <div className="sentence">{children}</div>
      {action && <button className="btn sm ghost insight-go" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}
