import { useCallback, useRef, useState } from 'react';

export interface GraphView { x: number; y: number; w: number; h: number }

const MIN_SCALE = 0.4;
const MAX_SCALE = 6;

/**
 * Wheel-zoom + drag-pan over an SVG viewBox, plus a click-vs-drag guard —
 * shared by any page.tsx that renders a pannable node/box canvas (Schema
 * diagram, Lineage graph, and whatever comes next). `naturalWidth`/
 * `naturalHeight` are the diagram's own 1:1 size in SVG user units; the view
 * starts fit to them and is re-fit whenever they change (a fresh layout).
 */
export function useGraphCanvas(naturalWidth: number, naturalHeight: number) {
  const [view, setView] = useState<GraphView>({ x: 0, y: 0, w: naturalWidth, h: naturalHeight });
  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; view: GraphView; moved: boolean } | null>(null);
  /** Set when a drag actually moved the view, so the click that follows mouseup doesn't select a node. */
  const suppressClickRef = useRef(false);

  const clampView = useCallback((v: GraphView): GraphView => {
    const minW = naturalWidth / MAX_SCALE, maxW = naturalWidth / MIN_SCALE;
    const w = Math.min(maxW, Math.max(minW, v.w));
    const h = w * (naturalHeight / naturalWidth);
    return { x: v.x, y: v.y, w, h };
  }, [naturalWidth, naturalHeight]);

  const zoomAt = useCallback((factor: number, clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    setView((cur) => {
      const userX = cur.x + px * cur.w;
      const userY = cur.y + py * cur.h;
      const next = clampView({ x: 0, y: 0, w: cur.w * factor, h: cur.h * factor });
      return { x: userX - px * next.w, y: userY - py * next.h, w: next.w, h: next.h };
    });
  }, [clampView]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    zoomAt(factor, e.clientX, e.clientY);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, view, moved: false };
    setIsDragging(true);
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      const container = containerRef.current;
      if (!d || !container) return;
      const rect = container.getBoundingClientRect();
      const dx = (ev.clientX - d.startX) * (d.view.w / rect.width);
      const dy = (ev.clientY - d.startY) * (d.view.h / rect.height);
      if (Math.abs(ev.clientX - d.startX) > 3 || Math.abs(ev.clientY - d.startY) > 3) d.moved = true;
      setView({ x: d.view.x - dx, y: d.view.y - dy, w: d.view.w, h: d.view.h });
    };
    const onUp = () => {
      suppressClickRef.current = dragRef.current?.moved ?? false;
      dragRef.current = null;
      setIsDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const zoomButton = (factor: number) => () => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const resetView = () => setView({ x: 0, y: 0, w: naturalWidth, h: naturalHeight });
  const scalePct = Math.round((naturalWidth / view.w) * 100);

  /** Call when a fresh layout arrives (new natural size) to re-fit the view. */
  const fitTo = (w: number, h: number) => setView({ x: 0, y: 0, w, h });

  return {
    view, isDragging, containerRef, svgRef, suppressClickRef,
    onWheel, onMouseDown, zoomButton, resetView, scalePct, fitTo,
  };
}

/**
 * A clean copy of the diagram at its natural, un-panned/zoomed size, as a
 * standalone SVG document string (own background rect, no CSS var refs —
 * export target has no access to the app's stylesheet).
 */
export function buildExportSvg(
  svg: SVGSVGElement | null, width: number, height: number, backgroundColor: string,
): string | null {
  if (!svg) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
  bg.setAttribute('width', String(width)); bg.setAttribute('height', String(height));
  bg.setAttribute('fill', backgroundColor);
  clone.insertBefore(bg, clone.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** Rasterize an SVG string to a PNG data URL via an offscreen canvas, at `scale`x for sharpness. */
export function rasterizeSvgToPng(svgText: string, width: number, height: number, scale = 2): Promise<string> {
  // A blob: URL would be blocked by the page's CSP (img-src is 'self' data:
  // only) — a data: URI is both allowed and needs no revoke bookkeeping.
  const svgDataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('canvas unavailable')); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Failed to rasterize the diagram.'));
    img.src = svgDataUri;
  });
}
