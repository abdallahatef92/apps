import { useEffect, useState } from 'react';

/**
 * Resolve theme tokens (CSS custom properties on <html>) to concrete colour
 * strings, re-resolving whenever `data-theme` changes.
 *
 * For drawings that leave the app — the SVG/PNG export of the schema and
 * lineage diagrams clones the <svg> into a standalone document with no access
 * to styles.css, so a `var(--…)` reference there would resolve to nothing.
 * Drawing with the resolved value keeps screen and export identical while
 * still following the active theme.
 */
export function resolveToken(name: string): string {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color; // always rgb()/rgba()
  probe.remove();
  return value;
}

export function useThemeTokens<K extends string>(map: Record<K, string>): Record<K, string> {
  const resolveAll = () => {
    const out = {} as Record<K, string>;
    for (const k of Object.keys(map) as K[]) out[k] = resolveToken(map[k]);
    return out;
  };
  const [tokens, setTokens] = useState(resolveAll);
  useEffect(() => {
    const obs = new MutationObserver(() => setTokens(resolveAll()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return tokens;
}

function luminance(rgb: string): number {
  const m = rgb.match(/[\d.]+/g);
  if (!m || m.length < 3) return 0;
  const [r, g, b] = m.slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whichever of two candidate inks contrasts more with `fill` (all resolved colours). */
export function inkOn(fill: string, a: string, b: string): string {
  const lf = luminance(fill);
  const ratio = (c: string) => {
    const lc = luminance(c);
    return (Math.max(lf, lc) + 0.05) / (Math.min(lf, lc) + 0.05);
  };
  return ratio(a) >= ratio(b) ? a : b;
}
