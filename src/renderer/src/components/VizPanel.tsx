import type { QueryResult, VizSpec } from '@shared/types';
import { LineChart } from '../charts/LineChart';
import { BarChart } from '../charts/BarChart';
import { Treemap } from '../charts/Treemap';
import { Heatmap } from '../charts/Heatmap';

/**
 * Renders a result set according to the visualisation spec stored with its query.
 * The spec names columns; nothing here decides what to aggregate.
 */
export function VizPanel({ result, viz, height = 320 }:
  { result: QueryResult; viz: VizSpec; height?: number }) {
  const has = (c?: string) => !!c && result.columns.includes(c);

  if (viz.kind === 'line' && has(viz.x) && viz.series?.some((s) => has(s.column))) {
    return (
      <LineChart result={result} xColumn={viz.x!} height={height} area={viz.area}
                 series={viz.series!.filter((s) => has(s.column))} />
    );
  }
  if (viz.kind === 'bar' && has(viz.label) && has(viz.value)) {
    return (
      <BarChart result={result} labelColumn={viz.label!} valueColumn={viz.value!}
                diverging={viz.diverging}
                referenceColumn={has(viz.reference) ? viz.reference : undefined}
                referenceLabel={viz.referenceLabel} />
    );
  }
  if (viz.kind === 'treemap' && has(viz.label) && has(viz.value)) {
    return (
      <Treemap result={result} labelColumn={viz.label!} sizeColumn={viz.value!}
               colorColumn={has(viz.color) ? viz.color : undefined}
               codeColumn={has('wbs_code') ? 'wbs_code' : undefined} height={height} />
    );
  }
  if (viz.kind === 'heatmap' && has(viz.row) && has(viz.col) && has(viz.value)) {
    return <Heatmap result={result} rowColumn={viz.row!} colColumn={viz.col!} valueColumn={viz.value!} />;
  }
  return (
    <div className="empty">
      This analysis has no chart — the table below is the result.
    </div>
  );
}

/** Whether a spec can actually draw against these columns. */
export function vizRenders(result: QueryResult, viz: VizSpec): boolean {
  const has = (c?: string) => !!c && result.columns.includes(c);
  switch (viz.kind) {
    case 'line': return has(viz.x) && !!viz.series?.some((s) => has(s.column));
    case 'bar': return has(viz.label) && has(viz.value);
    case 'treemap': return has(viz.label) && has(viz.value);
    case 'heatmap': return has(viz.row) && has(viz.col) && has(viz.value);
    default: return false;
  }
}
