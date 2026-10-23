import { useEffect, useRef, useState, type ReactNode, type PointerEvent as RPE } from 'react';
import { renderPage, freeCanvas, type PDFDocumentProxy } from '../lib/pdfjs';

export interface Pt { x: number; y: number }
export interface StageApi { toPt: (e: { clientX: number; clientY: number }) => Pt; scale: number; width: number; height: number }

/**
 * 顯示單一頁面 + 疊加層。疊加層座標單位為 pt（視覺座標，左上原點）。
 * `scale` 為 CSS 像素 / pt。
 */
export function PageStage({ pdf, pageIndex, scale, children, onDown, onMove, onUp, cursor, lockTouch, night }: {
  pdf: PDFDocumentProxy; pageIndex: number; scale: number; cursor?: string; lockTouch?: boolean; night?: boolean;
  children?: (api: StageApi) => ReactNode;
  onDown?: (p: Pt, e: RPE) => void; onMove?: (p: Pt, e: RPE) => void; onUp?: (p: Pt, e: RPE) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      const page = await pdf.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: 1 });
      if (dead) return;
      setSize({ w: vp.width, h: vp.height });
      if (canvas.current) await renderPage(page, scale * Math.min(window.devicePixelRatio || 1, 2), canvas.current);
      page.cleanup();
    })().catch(() => {});
    return () => { dead = true; };
  }, [pdf, pageIndex, scale]);
  useEffect(() => () => { if (canvas.current) freeCanvas(canvas.current); }, []);

  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  const w = (size?.w ?? 595) * scale, h = (size?.h ?? 842) * scale;
  return (
    <div ref={box} className={`relative mx-auto bg-white pdf-page-shadow ${night ? 'night-pdf' : ''}`} style={{ width: w, height: h }}>
      <canvas ref={canvas} style={{ width: w, height: h, display: 'block' }} />
      <div
        className="absolute inset-0 select-none"
        style={{ cursor, touchAction: lockTouch ? 'none' : 'pan-x pan-y pinch-zoom' }}
        onPointerDown={(e) => { if (!onDown) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); onDown(toPt(e), e); }}
        onPointerMove={(e) => onMove?.(toPt(e), e)}
        onPointerUp={(e) => onUp?.(toPt(e), e)}
        onPointerCancel={(e) => onUp?.(toPt(e), e)}
      >
        {size && children?.({ toPt, scale, width: size.w, height: size.h })}
      </div>
    </div>
  );
}

/** 簡單的頁面切換列 */
export function PageNav({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <button className="btn btn-sm" disabled={page <= 0} onClick={() => onChange(page - 1)} aria-label="上一頁">‹</button>
      <input className="input !min-h-8 !w-16 !px-2 !py-1 text-center" inputMode="numeric" value={page + 1}
        onChange={(e) => { const n = parseInt(e.target.value, 10); if (n >= 1 && n <= total) onChange(n - 1); }} aria-label="頁碼" />
      <span className="text-xs text-slate-500">/ {total}</span>
      <button className="btn btn-sm" disabled={page >= total - 1} onClick={() => onChange(page + 1)} aria-label="下一頁">›</button>
    </div>
  );
}
