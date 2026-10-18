import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { SheetTabs } from '../components/SheetTabs';
import { CostTypes, glUncoded } from './CostTypes';
import { PackageMapping } from './PackageMapping';
import type { CostTypeCombination, MaterialPackageCombination, ServicePackageCombination } from '@shared/types';

export type CodingTab = 'gl' | 'materials' | 'services' | 'other' | 'lists';

interface Gap { n: number; amount: number }
const gap = <T,>(rows: T[], open: (r: T) => boolean, amount: (r: T) => number): Gap =>
  rows.filter(open).reduce((g, r) => ({ n: g.n + 1, amount: g.amount + Math.abs(amount(r)) }), { n: 0, amount: 0 });

/**
 * The one Coding page (simplification step 2): GL → cost type, materials and subcontract services → work
 * package (+ MNL), the other GLs, and the two catalogues — one tab each, the same tables the old Cost types
 * and Work packages pages had. "Only what still needs coding" (on by default) hides what is already coded.
 */
export function Coding({ tab, onTab }: { tab?: CodingTab; onTab: (t: CodingTab) => void }) {
  const { projectKey, project, dataVersion } = useApp();
  const [onlyUncoded, setOnlyUncoded] = useState(true);
  const [gaps, setGaps] = useState<{ gl: Gap; materials: Gap; services: Gap } | null>(null);

  // The counts on the tabs: the same combination lists the tabs load, reduced to what is not coded yet.
  useEffect(() => {
    let live = true;
    (async () => {
      const gl = await api.costTypes.combinations();
      const mat = projectKey ? await api.workPackages.materialCombinations(projectKey) : null;
      const svc = projectKey ? await api.workPackages.serviceCombinations(projectKey) : null;
      if (!live) return;
      setGaps({
        gl: gap((gl.ok ? gl.data : []) as CostTypeCombination[], glUncoded, (r) => r.amount),
        materials: gap((mat?.ok ? mat.data : []) as MaterialPackageCombination[], (r) => !r.resolved_work_package, (r) => r.amount),
        // a service item appears once per PO; count each code + text once
        services: gap(Object.values(Object.fromEntries(((svc?.ok ? svc.data : []) as ServicePackageCombination[])
          .map((r) => [`${r.service_code}\u0000${r.service_text}`, r]))), (r) => !r.resolved_work_package, (r) => r.amount),
      });
    })();
    return () => { live = false; };
  }, [projectKey, dataVersion]);

  const auto: CodingTab = !gaps ? 'gl'
    : gaps.gl.n > 0 ? 'gl' : gaps.materials.n > 0 ? 'materials' : gaps.services.n > 0 ? 'services' : 'gl';
  const active = tab ?? auto;
  const cur = project?.currency_code ?? '';
  const label = (text: string, g?: Gap) => (g && g.n > 0 ? `${text} · ${g.n}` : text);
  const totalOpen = gaps ? gaps.gl.n + gaps.materials.n + gaps.services.n : null;

  return (
    <>
      <div className="card coding-head">
        <div>
          {totalOpen === null ? <span className="faint">Counting what still needs coding…</span>
            : totalOpen === 0 ? <strong>Everything is coded.</strong>
            : <>
                <strong>{totalOpen} item{totalOpen === 1 ? '' : 's'} still need coding</strong>
                <span className="faint">
                  {' '}· {gaps!.gl.n} GL / document-type pair{gaps!.gl.n === 1 ? '' : 's'} on Other (cost types are shared by all projects)
                  {' '}· {gaps!.materials.n} material{gaps!.materials.n === 1 ? '' : 's'} ({money(gaps!.materials.amount, cur)})
                  {' '}· {gaps!.services.n} service item{gaps!.services.n === 1 ? '' : 's'} ({money(gaps!.services.amount, cur)}) without a package
                </span>
              </>}
        </div>
        <label className="row" style={{ gap: 8, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={onlyUncoded} onChange={(e) => setOnlyUncoded(e.target.checked)} />
          <span>Only what still needs coding</span>
        </label>
      </div>

      <SheetTabs activeId={active} onActiveChange={(id) => onTab(id as CodingTab)} sheets={[
        { id: 'gl', label: label('GL accounts', gaps?.gl), content: () => <CostTypes part="allocate" onlyUncoded={onlyUncoded} /> },
        { id: 'materials', label: label('Materials', gaps?.materials), content: () => <PackageMapping tab="materials" onlyUncoded={onlyUncoded} /> },
        { id: 'services', label: label('Subcontract services', gaps?.services), content: () => <PackageMapping tab="subcontractors" onlyUncoded={onlyUncoded} /> },
        { id: 'other', label: 'Other GLs', content: () => <PackageMapping tab="other" /> },
        { id: 'lists', label: 'Lists', content: () => (
          <>
            <CostTypes part="catalog" />
            <PackageMapping tab="packages" />
          </>
        ) },
      ]} />
    </>
  );
}
