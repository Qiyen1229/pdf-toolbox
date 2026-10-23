import { useCallback, useEffect, useRef, useState } from 'react';
import { PdfPicker, PageThumb, usePdfDoc, type PdfSource } from '../components/common';
import { renderPage, freeCanvas, pageTextItems, type PDFDocumentProxy } from '../lib/pdfjs';
import { reportUsage } from '../lib/api';

function LazyPage({ pdf, index, scale, night, onVisible }: { pdf: PDFDocumentProxy; index: number; scale: number; night: boolean; onVisible: (i: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 595, h: 842 });
  const [vis, setVis] = useState(false);
  useEffect(() => { let dead = false; pdf.getPage(index + 1).then((p) => { const v = p.getViewport({ scale: 1 }); if (!dead) setDims({ w: v.width, h: v.height }); p.cleanup(); }); return () => { dead = true; }; }, [pdf, index]);
  useEffect(() => {
    const el = wrap.current!;
    const io = new IntersectionObserver(([e]) => { setVis(e.isIntersecting); if (e.intersectionRatio > 0.5) onVisible(index); }, { rootMargin: '600px 0px', threshold: [0, 0.5] });
    io.observe(el); return () => io.disconnect();
  }, [index, onVisible]);
  useEffect(() => {
    if (!vis) { if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; } return; }
    let dead = false;
    (async () => {
      const p = await pdf.getPage(index + 1);
      if (dead || !canvas.current) return;
      await renderPage(p, scale * Math.min(window.devicePixelRatio || 1, 2), canvas.current);
      p.cleanup();
    })().catch(() => {});
    return () => { dead = true; };
  }, [vis, pdf, index, scale]);
  useEffect(() => () => { if (canvas.current) freeCanvas(canvas.current); }, []);
  return (
    <div ref={wrap} data-page={index} className="mx-auto mb-3 bg-white pdf-page-shadow" style={{ width: dims.w * scale, height: dims.h * scale }}>
      <canvas ref={canvas} style={{ width: dims.w * scale, height: dims.h * scale, display: 'block' }} />
    </div>
  );
}

export default function Viewer() {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const { doc } = usePdfDoc(src?.bytes ?? null);
  const [page, setPage] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [mode, setMode] = useState<'continuous' | 'single'>('continuous');
  const [night, setNight] = useState(false);
  const [thumbs, setThumbs] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [lang, setLang] = useState('auto');
  const [pinch, setPinch] = useState(1);
  const area = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const startDist = useRef(0);
  const live = useRef(1);
  const speakingRef = useRef(false);

  useEffect(() => { if (src) reportUsage('viewer', src.originalSize); setPage(0); }, [src]);
  const fitWidth = useCallback(async () => {
    if (!doc || !area.current) return;
    const p = await doc.getPage(1);
    setScale(Math.max(0.4, Math.min(3, (area.current.clientWidth - 24) / p.getViewport({ scale: 1 }).width)));
  }, [doc]);
  useEffect(() => { void fitWidth(); }, [fitWidth]);

  const goto = (i: number) => {
    if (!doc) return; const n = Math.max(0, Math.min(doc.numPages - 1, i)); setPage(n);
    if (mode === 'continuous') area.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: 'start' });
  };
  // 鍵盤
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') goto(page + 1);
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') goto(page - 1);
      if (e.key === '+' || e.key === '=') setScale((s) => Math.min(4, s * 1.15));
      if (e.key === '-') setScale((s) => Math.max(0.3, s / 1.15));
    };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  });

  // 捏合縮放（雙指）；單指/雙指拖曳交給原生捲動
  const dist = () => { const [a, b] = [...pointers.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const pd = (e: React.PointerEvent) => { if (e.pointerType !== 'touch') return; pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pointers.current.size === 2) { startDist.current = dist(); live.current = 1; } };
  const pm = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && startDist.current) { live.current = Math.min(3, Math.max(0.4, dist() / startDist.current)); setPinch(live.current); }
  };
  const pu = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size < 2 && startDist.current) { setScale((s) => Math.min(4, Math.max(0.3, s * live.current))); startDist.current = 0; live.current = 1; setPinch(1); }
  };

  // 朗讀
  const speak = async (i: number) => {
    if (!doc || !speakingRef.current) return;
    const p = await doc.getPage(i + 1);
    const text = (await pageTextItems(p)).map((t) => t.str).join(' ').trim();
    p.cleanup();
    if (!text) { if (i + 1 < doc.numPages) { goto(i + 1); return void speak(i + 1); } return stop(); }
    const u = new SpeechSynthesisUtterance(text);
    const cjk = (text.match(/[㐀-鿿]/g) ?? []).length / text.length > 0.2;
    u.lang = lang === 'auto' ? (cjk ? 'zh-TW' : 'en-US') : lang;
    u.onend = () => { if (speakingRef.current && i + 1 < doc.numPages) { goto(i + 1); void speak(i + 1); } else stop(); };
    u.onerror = () => stop();
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  };
  const stop = () => { speakingRef.current = false; setSpeaking(false); try { speechSynthesis.cancel(); } catch { /* ignore */ } };
  useEffect(() => () => { try { speechSynthesis.cancel(); } catch { /* ignore */ } }, []);
  const canSpeak = typeof speechSynthesis !== 'undefined';

  const fullscreen = () => {
    const el = root.current as any; if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el); // iOS Safari 的 iPhone 不支援，會被忽略
  };
  const canFs = !!(document.documentElement.requestFullscreen || (document.documentElement as any).webkitRequestFullscreen);

  if (!src) return <div className="mx-auto max-w-2xl space-y-3"><PdfPicker value={null} onChange={setSrc} label="選擇要閱讀的 PDF" /><p className="hint text-center">檢視器完全在本機執行：縮放、縮圖、夜間模式、朗讀，支援雙指捏合。</p></div>;
  return (
    <div ref={root} className={`flex h-[calc(100dvh-8.5rem)] min-h-[420px] flex-col overflow-hidden rounded-xl border bg-slate-100 dark:border-slate-700 dark:bg-slate-900`}>
      <div className="flex flex-wrap items-center gap-1.5 border-b bg-white p-2 dark:border-slate-700 dark:bg-slate-900" role="toolbar">
        <button className="btn btn-sm" onClick={() => setThumbs((v) => !v)} aria-pressed={thumbs}>🗂 縮圖</button>
        <button className="btn btn-sm" disabled={page <= 0} onClick={() => goto(page - 1)} aria-label="上一頁">‹</button>
        <input className="input !min-h-8 !w-14 !px-1 text-center" inputMode="numeric" value={page + 1} onChange={(e) => { const n = parseInt(e.target.value, 10); if (n >= 1) goto(n - 1); }} aria-label="頁碼" />
        <span className="text-xs text-slate-500">/ {src.pages}</span>
        <button className="btn btn-sm" disabled={page >= src.pages - 1} onClick={() => goto(page + 1)} aria-label="下一頁">›</button>
        <span className="mx-1 h-5 w-px bg-slate-300" />
        <button className="btn btn-sm" onClick={() => setScale((s) => Math.max(0.3, s / 1.2))} aria-label="縮小">－</button>
        <span className="w-11 text-center text-xs">{Math.round(scale * 100)}%</span>
        <button className="btn btn-sm" onClick={() => setScale((s) => Math.min(4, s * 1.2))} aria-label="放大">＋</button>
        <button className="btn btn-sm" onClick={() => void fitWidth()}>符合寬度</button>
        <button className="btn btn-sm" onClick={() => setMode((m) => (m === 'continuous' ? 'single' : 'continuous'))}>{mode === 'continuous' ? '連續' : '單頁'}</button>
        <button className={`btn btn-sm ${night ? 'btn-primary' : ''}`} onClick={() => setNight((v) => !v)} aria-pressed={night}>🌙 夜間</button>
        {canFs && <button className="btn btn-sm" onClick={fullscreen}>⛶ 全螢幕</button>}
        {canSpeak && (speaking
          ? <button className="btn btn-sm btn-primary" onClick={stop}>⏹ 停止朗讀</button>
          : <button className="btn btn-sm" onClick={() => { speakingRef.current = true; setSpeaking(true); void speak(page); }}>🔊 朗讀</button>)}
        {canSpeak && <select className="input !min-h-8 !w-auto !py-0.5 text-xs" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="朗讀語言">
          <option value="auto">自動語言</option><option value="zh-TW">國語（台灣）</option><option value="zh-CN">普通话</option><option value="ja-JP">日本語</option><option value="en-US">English</option></select>}
        <button className="btn btn-sm ml-auto" onClick={() => setSrc(null)}>關閉</button>
      </div>
      <div className="flex min-h-0 flex-1">
        {thumbs && doc && (
          <aside className="hidden w-40 shrink-0 overflow-y-auto border-r bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-950 sm:block">
            {Array.from({ length: src.pages }, (_, i) => (
              <button key={i} onClick={() => goto(i)} className={`mb-2 block w-full rounded p-1 ${i === page ? 'bg-brand-100 ring-2 ring-brand-500 dark:bg-brand-600/20' : ''}`}>
                <PageThumb pdf={doc} index={i} width={120} className="mx-auto" /><div className="mt-0.5 text-center text-xs">{i + 1}</div>
              </button>
            ))}
          </aside>
        )}
        <div ref={area} className={`min-w-0 flex-1 overflow-auto p-3 ${night ? 'night-pdf bg-slate-900' : ''}`}
          style={{ touchAction: 'pan-x pan-y' }} onPointerDown={pd} onPointerMove={pm} onPointerUp={pu} onPointerCancel={pu}>
          {doc && (
            <div style={{ transform: pinch !== 1 ? `scale(${pinch})` : undefined, transformOrigin: 'top center' }}>
              {mode === 'continuous'
                ? Array.from({ length: src.pages }, (_, i) => <LazyPage key={i} pdf={doc} index={i} scale={scale} night={night} onVisible={setPage} />)
                : <LazyPage key={page} pdf={doc} index={page} scale={scale} night={night} onVisible={() => {}} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
