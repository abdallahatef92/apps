import { useState, type DragEvent } from 'react';
import { api } from '../lib/api';
import type { BuildStatus, BuildStepStatus, BuildTimelineBar } from '@shared/types';

/**
 * Home's map view: the actual-cost source architecture (Project_Build_Workspace_Plan.md, rev. 4).
 * CJI3 is the spine that feeds every cost category; each category lists the detail sources that
 * replace CJI3 for it once loaded. Every source is a card that shows its status and accepts a file
 * dropped on it. The layout is presentation only — status, lines and dates come from BUILD_STATUS
 * and BUILD_TIMELINE, and the rule itself lives in cost_source_rule / v_actual_cost.
 */

interface Category { key: string; label: string; note: string; teal?: boolean; steps: string[]; sharedWith?: string }

const CATEGORIES: Category[] = [
  { key: 'SUBCONTRACT', label: 'Subcontractor', note: 'Certificates replace CJI3 per PO', steps: ['B07', 'B08', 'B15'] },
  { key: 'MATERIAL', label: 'Material', note: 'MB51 replaces CJI3', steps: ['B06', 'B09', 'B10'] },
  { key: 'LABOR', label: 'Labor', note: '+ subcontract services coded LAB', teal: true, steps: ['B16'] },
  { key: 'EQUIPMENT', label: 'Equipment / fuel', note: '+ subcontract services coded EQU', teal: true, steps: ['B05'] },
  { key: 'FLEET', label: 'Fleet / transport rent', note: 'Order detail replaces CJI3', steps: [], sharedWith: 'B05' },
  { key: 'HOUSING', label: 'House rent', note: 'Order detail replaces CJI3', steps: [], sharedWith: 'B05' },
  { key: 'DEPRECIATION', label: 'Asset depreciation', note: 'Asset sheet replaces CJI3', steps: ['B17'] },
  { key: 'GA', label: 'G&A (finance, HR)', note: 'CJI3 only', steps: [] },
];

/** The SAP transaction / file each step loads, shown as the card title. */
const SOURCE_CODE: Record<string, string> = {
  B04: 'CJI3', B07: 'ZSCPROG01', B08: 'ZSCSRV1', B15: 'Deductions', B06: 'MB51', B09: 'ME2N', B10: 'MB52',
  B05: 'ZINTC1', B16: 'Labour form', B17: 'Asset sheet', B02: 'WBS', B03: 'Budget',
};
const OFFLINE = new Set(['B16', 'B17']);
const BOTTOM = ['B01', 'B02', 'B03', 'B11', 'B12', 'B18'];

const STATUS_DOT: Record<BuildStatus, string> = {
  'Complete': 'good', 'Behind cut-off': 'warn', 'Needs action': 'warn', 'Ready to load': 'accent',
  'Waiting': 'wait', 'Optional': 'ring', 'Not available': 'ring',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYr = (iso: string | null) => {
  const m = iso ? /^(\d{4})-(\d{2})/.exec(iso) : null;
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}` : '';
};

export interface ArchMapProps {
  steps: BuildStepStatus[];
  bars: Map<string, BuildTimelineBar[]>;
  selectedCode: string | null;
  onSelect: (code: string) => void;
  /** Open the upload wizard on this step, optionally with a file already dropped. */
  onLoad: (step: BuildStepStatus, path?: string) => void;
  /** Refresh CJI3 live from S/4HANA instead of a file (the CJI3 card's ⟳ SAP button). */
  onSap?: () => void;
}

/** A source the user cannot load yet: no report behind it, or the SAP report is not available. */
function isPending(s: BuildStepStatus, bars: BuildTimelineBar[]): boolean {
  if (bars.length > 0) return false;
  return s.status === 'Not available' || (OFFLINE.has(s.step_code) && s.report_definition_id == null);
}

export function ArchMap({ steps, bars, selectedCode, onSelect, onLoad, onSap }: ArchMapProps) {
  const byCode = new Map(steps.map((s) => [s.step_code, s]));
  const spine = byCode.get('B04');
  const costTypes = byCode.get('B11');

  const card = (code: string, big = false) => {
    const s = byCode.get(code);
    if (!s) return null;
    // Nothing can be loaded yet (a SAP report in development, an offline form with no template):
    // a note, not a card, so it does not read as a task.
    if (isPending(s, bars.get(code) ?? [])) {
      return <span key={code} className="arch-note" title={s.summary}>
        {s.name} — {s.status === 'Not available' ? 'SAP report in development' : 'offline Excel, template pending'}
      </span>;
    }
    return <SourceCard key={code} step={s} bars={bars.get(code) ?? []} big={big} selected={selectedCode === code}
                       onSelect={onSelect} onLoad={onLoad} onSap={code === 'B04' ? onSap : undefined} />;
  };

  return (
    <div className="arch">
      <div className="arch-grid">
        <div className="arch-spine">
          {spine && card('B04', true)}
          {costTypes && (
            <button className={`arch-chip ${costTypes.status === 'Needs action' ? 'warn' : ''} ${selectedCode === 'B11' ? 'sel' : ''}`}
                    onClick={() => onSelect('B11')} title={costTypes.summary}>
              <span className={`sdot ${STATUS_DOT[costTypes.status]}`} />Cost types · {costTypes.status}
            </button>
          )}
          <span className="arch-feeds">feeds every cost category</span>
        </div>
        <div className="arch-rows">
          {CATEGORIES.map((c) => (
            <div key={c.key} className="arch-row">
              <div className="arch-link" />
              <div className="arch-cat">
                <strong>{c.label}</strong>
                <span className={c.teal ? 'arch-teal' : 'faint'}>{c.note}</span>
              </div>
              <div className={`arch-link ${c.steps.length === 0 && !c.sharedWith ? 'dotted' : ''}`} />
              <div className="arch-sources">
                {c.steps.map((code) => card(code))}
                {c.sharedWith && (
                  <button className={`arch-card shared ${selectedCode === c.sharedWith ? 'sel' : ''}`}
                          onClick={() => onSelect(c.sharedWith!)}>
                    <span className="faint">same {SOURCE_CODE[c.sharedWith]} file as Equipment</span>
                  </button>
                )}
                {c.steps.length === 0 && !c.sharedWith && <span className="arch-none">no detail source — CJI3 is the actual</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="arch-bottom">
        <span className="arch-bottom-label">Project, structure and coding</span>
        <div className="arch-sources">{BOTTOM.map((code) => card(code))}</div>
      </div>
    </div>
  );
}

function SourceCard({ step, bars, big, selected, onSelect, onLoad, onSap }: {
  step: BuildStepStatus; bars: BuildTimelineBar[]; big: boolean; selected: boolean;
  onSelect: (code: string) => void; onLoad: (step: BuildStepStatus, path?: string) => void; onSap?: () => void;
}) {
  const [over, setOver] = useState(false);
  const canLoad = step.kind === 'upload' && step.report_definition_id != null && step.status !== 'Not available';
  const dated = bars.filter((b) => b.date_from);
  const from = dated.length ? dated.map((b) => b.date_from!).sort()[0] : null;
  const to = dated.length ? dated.map((b) => b.date_to!).sort().slice(-1)[0] : null;
  const loaded = bars.length > 0 || (step.kind !== 'upload' && (step.status === 'Complete' || step.status === 'Needs action'));
  const tone = step.status === 'Not available' ? 'na'
    : loaded ? (step.status === 'Complete' ? 'ok' : 'attn')
    : step.status === 'Ready to load' || step.status === 'Needs action' ? 'todo' : 'idle';

  const drop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = e.dataTransfer.files[0];
    if (f && canLoad) onLoad(step, api.files.pathOf(f) || undefined);
  };

  return (
    <div className={`arch-card ${tone}${OFFLINE.has(step.step_code) ? ' offline' : ''}${big ? ' big' : ''}${selected ? ' sel' : ''}${over ? ' over' : ''}`}
         role="button" tabIndex={0}
         onClick={() => onSelect(step.step_code)}
         onKeyDown={(e) => { if (e.key === 'Enter') onSelect(step.step_code); }}
         onDragOver={(e) => { if (canLoad) { e.preventDefault(); setOver(true); } }}
         onDragLeave={() => setOver(false)}
         onDrop={drop}
         title={step.summary}>
      <div className="arch-card-top">
        <strong>{SOURCE_CODE[step.step_code] ?? step.name}</strong>
        <span className="row" style={{ gap: 4 }}>
          {onSap && (
            <button className="arch-load" title="Refresh live from S/4HANA (instead of a CJI3 file)"
                    onClick={(e) => { e.stopPropagation(); onSap(); }}>⟳ SAP</button>
          )}
          {canLoad && (
            <button className="arch-load" title={`Load ${SOURCE_CODE[step.step_code] ?? step.name}`}
                    onClick={(e) => { e.stopPropagation(); onLoad(step); }}>↥</button>
          )}
        </span>
      </div>
      <span className="arch-name">{step.name}</span>
      <span className="arch-status"><span className={`sdot ${STATUS_DOT[step.status]}`} />{step.status}</span>
      {bars.length > 0 ? (
        <span className="faint arch-meta">
          {from ? `${monthYr(from)} – ${monthYr(to)}` : `data date ${monthYr(bars[0].data_date)}`}
          {step.lines > 0 && ` · ${step.lines.toLocaleString()} lines`}
        </span>
      ) : canLoad ? (
        <span className="arch-meta arch-drop">{over ? 'Release to load' : 'Drop a file or click ↥'}</span>
      ) : step.status === 'Not available' ? (
        <span className="faint arch-meta">SAP report in development</span>
      ) : OFFLINE.has(step.step_code) ? (
        <span className="faint arch-meta">offline Excel · template pending</span>
      ) : null}
    </div>
  );
}
