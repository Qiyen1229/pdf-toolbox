import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../lib/pdfjs';
import { PageNav, PageStage, type Pt } from './PageStage';
import { Spinner } from './common';
import type { Ann, AnnMap } from '../tools/ops/annotate';
import type { RGB } from '../tools/ops/stamp';
import { readBytes, sniffImage } from '../lib/files';

type Tool = 'select' | 'highlight' | 'underline' | 'strike' | 'squiggly' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'pen' | 'text' | 'note' | 'stamp' | 'signature' | 'image';
const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: 'select', icon: '☝️', label: '選取/移動' }, { id: 'highlight', icon: '🖍️', label: '螢光筆' }, { id: 'underline', icon: 'U̲', label: '底線' },
  { id: 'strike', icon: 'S̶', label: '刪除線' }, { id: 'squiggly', icon: '〰️', label: '波浪線' }, { id: 'rect', icon: '▭', label: '矩形' },
  { id: 'ellipse', icon: '◯', label: '橢圓' }, { id: 'line', icon: '／', label: '直線' }, { id: 'arrow', icon: '➜', label: '箭頭' },
  { id: 'pen', icon: '✏️', label: '手寫' }, { id: 'text', icon: 'T', label: '文字方塊' }, { id: 'note', icon: '🗒️', label: '便利貼' },
  { id: 'stamp', icon: '🔖', label: '圖章' }, { id: 'signature', icon: '✍️', label: '簽名' }, { id: 'image', icon: '🖼️', label: '插入圖片' },
];
const COLORS: { c: RGB; n: string }[] = [
  { c: [255, 214, 0], n: '黃' }, { c: [239, 68, 68], n: '紅' }, { c: [34, 197, 94], n: '綠' }, { c: [59, 130, 246], n: '藍' },
  { c: [236, 72, 153], n: '粉' }, { c: [17, 24, 39], n: '黑' },
];
const STAMPS: { label: string; c: RGB }[] = [
  { label: '已核准', c: [22, 163, 74] }, { label: 'APPROVED', c: [22, 163, 74] }, { label: '草稿', c: [100, 116, 139] }, { label: 'DRAFT', c: [100, 116, 139] },
  { label: '機密', c: [220, 38, 38] }, { label: 'CONFIDENTIAL', c: [220, 38, 38] }, { label: '已審閱', c: [37, 99, 235] }, { label: '作廢', c: [220, 38, 38] },
  { label: '完成', c: [22, 163, 74] }, { label: 'VOID', c: [220, 38, 38] },
];
const cssRgb = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const uid = () => crypto.randomUUID();

function bbox(a: Ann) {
  switch (a.t) {
    case 'line': case 'arrow': return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    case 'ink': { const xs = a.pts.map((p) => p[0]), ys = a.pts.map((p) => p[1]); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
    case 'note': return { x: a.x, y: a.y, w: 20, h: 20 };
    case 'text': return { x: a.x, y: a.y, w: a.w, h: a.size * 1.25 * Math.max(1, a.text.split('\n').length) };
    default: return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}
function moveAnn(a: Ann, dx: number, dy: number): Ann {
  switch (a.t) {
    case 'line': case 'arrow': return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    case 'ink': return { ...a, pts: a.pts.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    default: return { ...a, x: (a as any).x + dx, y: (a as any).y + dy } as Ann;
  }
}

function SignaturePad({ onDone, onCancel }: { onDone: (png: Uint8Array, w: number, h: number) => void; onCancel: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState('#111827');
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);
  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: (e.clientX - r.left) * (ref.current!.width / r.width), y: (e.clientY - r.top) * (ref.current!.height / r.height) }; };
  const down = (e: React.PointerEvent) => { drawing.current = true; ref.current!.setPointerCapture(e.pointerId); const c = ref.current!.getContext('2d')!; const p = pos(e); c.beginPath(); c.moveTo(p.x, p.y); c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = 5; c.strokeStyle = color; };
  const move = (e: React.PointerEvent) => { if (!drawing.current) return; const c = ref.current!.getContext('2d')!; const p = pos(e); c.lineTo(p.x, p.y); c.stroke(); setDirty(true); };
  const finish = async () => {
    const c = ref.current!; const ctx = c.getContext('2d')!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 <= x0) return;
    const out = document.createElement('canvas'); const pad = 6;
    out.width = x1 - x0 + pad * 2; out.height = y1 - y0 + pad * 2;
    out.getContext('2d')!.drawImage(c, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
    const blob: Blob = await new Promise((r) => out.toBlob((b) => r(b!), 'image/png'));
    onDone(new Uint8Array(await blob.arrayBuffer()), out.width, out.height);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" role="dialog" aria-modal>
      <div className="card w-full max-w-xl space-y-3">
        <div className="text-sm font-semibold">手寫簽名</div>
        <canvas ref={ref} width={900} height={320} className="w-full touch-none rounded-lg border border-dashed border-slate-400 bg-white" style={{ touchAction: 'none' }}
          onPointerDown={down} onPointerMove={move} onPointerUp={() => (drawing.current = false)} onPointerCancel={() => (drawing.current = false)} />
        <div className="flex flex-wrap items-center gap-2">
          {['#111827', '#1d4ed8', '#b91c1c'].map((c) => <button key={c} aria-label={c} onClick={() => setColor(c)} className={`h-7 w-7 rounded-full border-2 ${color === c ? 'border-brand-600' : 'border-transparent'}`} style={{ background: c }} />)}
          <button className="btn btn-sm" onClick={() => { const c = ref.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); setDirty(false); }}>清除</button>
          <span className="flex-1" />
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" disabled={!dirty} onClick={() => void finish()}>使用此簽名</button>
        </div>
      </div>
    </div>
  );
}

export function AnnotateEditor({ pdf, pageCount, anns, onChange, night }: { pdf: PDFDocumentProxy; pageCount: number; anns: AnnMap; onChange: (a: AnnMap) => void; night?: boolean }) {
  const [page, setPage] = useState(0);
  const [tool, setTool] = useState<Tool>('highlight');
  const [color, setColor] = useState<RGB>(COLORS[0].c);
  const [width, setWidth] = useState(2);
  const [fontSize, setFontSize] = useState(14);
  const [fill, setFill] = useState(false);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState(true);
  const [draft, setDraft] = useState<Ann | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [history, setHistory] = useState<AnnMap[]>([]);
  const [popup, setPopup] = useState<{ kind: 'text' | 'note'; x: number; y: number; value: string; editId?: string } | null>(null);
  const [sigOpen, setSigOpen] = useState(false);
  const [sig, setSig] = useState<{ png: Uint8Array; w: number; h: number } | null>(null);
  const [img, setImg] = useState<{ png: Uint8Array; w: number; h: number; url: string } | null>(null);
  const [stampIdx, setStampIdx] = useState(0);
  const [pageW, setPageW] = useState(595);
  const wrap = useRef<HTMLDivElement>(null);
  const dragStart = useRef<Pt | null>(null);
  const moved = useRef(false);

  useEffect(() => { pdf.getPage(1).then((p) => setPageW(p.getViewport({ scale: 1 }).width)); }, [pdf]);
  useEffect(() => {
    if (!fit || !wrap.current) return;
    const el = wrap.current;
    const calc = () => setScale(Math.max(0.3, Math.min(2, (el.clientWidth - 24) / pageW)));
    calc();
    const ro = new ResizeObserver(calc); ro.observe(el); return () => ro.disconnect();
  }, [fit, pageW]);

  const list = anns[page] ?? [];
  const commit = useCallback((next: AnnMap) => { setHistory((h) => [...h.slice(-49), anns]); onChange(next); }, [anns, onChange]);
  const setPageList = (l: Ann[]) => commit({ ...anns, [page]: l });
  const undo = () => setHistory((h) => { if (!h.length) return h; onChange(h[h.length - 1]); return h.slice(0, -1); });
  const selected = list.find((a) => a.id === sel);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); commit({ ...anns, [page]: list.filter((a) => a.id !== sel) }); setSel(null); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  });

  const hit = (p: Pt) => [...list].reverse().find((a) => { const b = bbox(a); const m = a.t === 'line' || a.t === 'arrow' || a.t === 'ink' ? 6 : 3; return p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m; });

  const onDown = (p: Pt) => {
    moved.current = false;
    if (tool === 'select') { const h = hit(p); setSel(h?.id ?? null); dragStart.current = h ? p : null; if (h) setHistory((x) => [...x.slice(-49), anns]); return; }
    setSel(null);
    const base = { id: uid(), color };
    if (['highlight', 'underline', 'strike', 'squiggly', 'rect', 'ellipse'].includes(tool)) {
      const t = tool as any;
      setDraft(tool === 'rect' || tool === 'ellipse' ? { ...base, t, x: p.x, y: p.y, w: 0, h: 0, fill, width } : { ...base, t, x: p.x, y: p.y, w: 0, h: 0 });
      dragStart.current = p;
    } else if (tool === 'line' || tool === 'arrow') { setDraft({ ...base, t: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, width }); dragStart.current = p; }
    else if (tool === 'pen') { setDraft({ ...base, t: 'ink', pts: [[p.x, p.y]], width }); dragStart.current = p; }
    else if (tool === 'text') setPopup({ kind: 'text', x: p.x, y: p.y, value: '' });
    else if (tool === 'note') setPopup({ kind: 'note', x: p.x, y: p.y, value: '' });
    else if (tool === 'stamp') { const s = STAMPS[stampIdx]; setPageList([...list, { ...base, color: s.c, t: 'stamp', x: p.x - 70, y: p.y - 18, w: 140, h: 36, label: s.label }]); }
    else if (tool === 'signature') { if (sig) { const w = 150, h = (sig.h / sig.w) * w; setPageList([...list, { ...base, t: 'image', x: p.x - w / 2, y: p.y - h / 2, w, h, png: sig.png }]); } else setSigOpen(true); }
    else if (tool === 'image' && img) { const w = Math.min(200, img.w), h = (img.h / img.w) * w; setPageList([...list, { ...base, t: 'image', x: p.x - w / 2, y: p.y - h / 2, w, h, png: img.png }]); }
  };
  const onMove = (p: Pt) => {
    if (tool === 'select' && sel && dragStart.current) {
      const dx = p.x - dragStart.current.x, dy = p.y - dragStart.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) moved.current = true;
      dragStart.current = p;
      onChange({ ...anns, [page]: list.map((a) => (a.id === sel ? moveAnn(a, dx, dy) : a)) });
      return;
    }
    if (!draft || !dragStart.current) return;
    const s = dragStart.current;
    if (draft.t === 'ink') setDraft({ ...draft, pts: [...draft.pts, [p.x, p.y]] });
    else if (draft.t === 'line' || draft.t === 'arrow') setDraft({ ...draft, x2: p.x, y2: p.y });
    else if ('w' in draft) setDraft({ ...draft, x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) } as Ann);
  };
  const onUp = () => {
    if (tool === 'select') { dragStart.current = null; return; }
    if (draft) {
      const tiny = 'w' in draft && (draft as any).w < 3 && (draft as any).h < 3;
      if (!tiny) {
        let d = draft;
        // 螢光筆/底線等若只是點擊，給預設高度
        if ((d.t === 'highlight' || d.t === 'underline' || d.t === 'strike' || d.t === 'squiggly') && d.h < 6) d = { ...d, h: 14 };
        setPageList([...list, d]);
      }
      setDraft(null); dragStart.current = null;
    }
  };
  const addPopup = () => {
    if (!popup || !popup.value.trim()) return setPopup(null);
    if (popup.editId) setPageList(list.map((a) => (a.id === popup.editId ? ({ ...a, text: popup.value } as Ann) : a)));
    else if (popup.kind === 'text') setPageList([...list, { id: uid(), color, t: 'text', x: popup.x, y: popup.y, w: Math.max(80, Math.min(260, pageW - popup.x - 10)), text: popup.value, size: fontSize }]);
    else setPageList([...list, { id: uid(), color: [250, 204, 21], t: 'note', x: popup.x, y: popup.y, text: popup.value }]);
    setPopup(null);
  };
  const total = useMemo(() => Object.values(anns).reduce((s, l) => s + l.length, 0), [anns]);

  const render = (a: Ann, scaleF: number, key: string, isDraft = false) => {
    const s = scaleF;
    const selStyle = sel === a.id ? { outline: '2px dashed #4f46e5', outlineOffset: 2 } : {};
    switch (a.t) {
      case 'highlight': return <div key={key} className="absolute" style={{ left: a.x * s, top: a.y * s, width: a.w * s, height: a.h * s, background: cssRgb(a.color, 0.5), mixBlendMode: 'multiply', ...selStyle }} />;
      case 'underline': case 'strike': case 'squiggly': {
        const y = a.t === 'strike' ? a.h / 2 : a.h;
        return <div key={key} className="absolute" style={{ left: a.x * s, top: a.y * s, width: a.w * s, height: a.h * s, ...selStyle }}>
          <div className="absolute w-full" style={{ top: y * s, borderTop: `${Math.max(1.5, s * 1.2)}px ${a.t === 'squiggly' ? 'dotted' : 'solid'} ${cssRgb(a.color)}` }} /></div>;
      }
      case 'rect': case 'ellipse': return <div key={key} className="absolute" style={{ left: a.x * s, top: a.y * s, width: a.w * s, height: a.h * s, border: `${a.width * s}px solid ${cssRgb(a.color)}`, borderRadius: a.t === 'ellipse' ? '50%' : 0, background: a.fill ? cssRgb(a.color, 0.25) : 'transparent', boxSizing: 'border-box', ...selStyle }} />;
      case 'text': return <div key={key} className="absolute whitespace-pre-wrap break-all" style={{ left: a.x * s, top: a.y * s, width: a.w * s, fontSize: a.size * s, lineHeight: 1.25, color: cssRgb(a.color), fontFamily: 'Helvetica, Arial, "PingFang TC", sans-serif', ...selStyle }}>{a.text}</div>;
      case 'note': return <div key={key} title={a.text} className="absolute flex items-center justify-center rounded-sm bg-yellow-300 text-xs shadow" style={{ left: a.x * s, top: a.y * s, width: 20 * s, height: 20 * s, ...selStyle }}>🗒</div>;
      case 'image': { const url = URL.createObjectURL(new Blob([a.png as BlobPart], { type: 'image/png' })); return <img key={key} src={url} onLoad={(e) => URL.revokeObjectURL(url)} alt="" draggable={false} className="absolute" style={{ left: a.x * s, top: a.y * s, width: a.w * s, height: a.h * s, ...selStyle }} />; }
      case 'stamp': return <div key={key} className="absolute flex items-center justify-center font-bold" style={{ left: a.x * s, top: a.y * s, width: a.w * s, height: a.h * s, border: `${2 * s}px solid ${cssRgb(a.color)}`, color: cssRgb(a.color), fontSize: Math.min(a.h * 0.55, (a.w / Math.max(2, a.label.length)) * 1.6) * s, boxSizing: 'border-box', ...selStyle }}>{a.label}</div>;
      case 'line': case 'arrow': case 'ink': return null; // SVG 層
    }
  };
  const svgShapes = (arr: Ann[]) => arr.map((a) => {
    if (a.t === 'line' || a.t === 'arrow') {
      const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1), L = 10 + a.width * 2;
      return <g key={a.id} stroke={cssRgb(a.color)} strokeWidth={a.width} strokeLinecap="round" fill="none" style={sel === a.id ? { filter: 'drop-shadow(0 0 2px #4f46e5)' } : undefined}>
        <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} />
        {a.t === 'arrow' && [-1, 1].map((s) => <line key={s} x1={a.x2} y1={a.y2} x2={a.x2 - L * Math.cos(ang + s * 0.45)} y2={a.y2 - L * Math.sin(ang + s * 0.45)} />)}
      </g>;
    }
    if (a.t === 'ink') return <polyline key={a.id} points={a.pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={cssRgb(a.color)} strokeWidth={a.width} strokeLinecap="round" strokeLinejoin="round" style={sel === a.id ? { filter: 'drop-shadow(0 0 2px #4f46e5)' } : undefined} />;
    return null;
  });

  return (
    <div className="space-y-3">
      <div className="card !p-2">
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="標記工具">
          {TOOLS.map((t) => (
            <button key={t.id} title={t.label} aria-label={t.label} aria-pressed={tool === t.id}
              onClick={() => {
                setTool(t.id); setSel(null);
                // 依工具給合理的預設顏色（黃色只適合螢光筆）
                if (t.id === 'highlight') setColor(COLORS[0].c);
                else if (t.id === 'text' || t.id === 'pen' || t.id === 'signature') setColor(COLORS[5].c);
                else if (['underline', 'strike', 'squiggly', 'rect', 'ellipse', 'line', 'arrow'].includes(t.id)) setColor(COLORS[1].c);
                if (t.id === 'signature' && !sig) setSigOpen(true);
              }}
              className={`btn btn-sm !min-w-9 ${tool === t.id ? 'btn-primary' : ''}`}><span aria-hidden>{t.icon}</span><span className="hidden lg:inline">{t.label}</span></button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-2 dark:border-slate-800">
          <div className="flex gap-1">{COLORS.map((c) => <button key={c.n} aria-label={c.n} onClick={() => { setColor(c.c); if (selected) commit({ ...anns, [page]: list.map((a) => (a.id === sel ? { ...a, color: c.c } : a)) }); }} className={`h-6 w-6 rounded-full border-2 ${color === c.c ? 'border-slate-900 dark:border-white' : 'border-white/0 ring-1 ring-slate-300'}`} style={{ background: cssRgb(c.c) }} />)}</div>
          <label className="flex items-center gap-1 text-xs">線寬<input type="range" min={1} max={10} value={width} onChange={(e) => setWidth(+e.target.value)} className="w-20" /></label>
          <label className="flex items-center gap-1 text-xs">字級<input type="number" min={8} max={72} value={fontSize} onChange={(e) => setFontSize(+e.target.value)} className="input !min-h-7 !w-16 !py-0.5" /></label>
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} />形狀填色</label>
          {tool === 'stamp' && <select className="input !min-h-8 !w-auto" value={stampIdx} onChange={(e) => setStampIdx(+e.target.value)}>{STAMPS.map((s, i) => <option key={i} value={i}>{s.label}</option>)}</select>}
          {tool === 'signature' && <button className="btn btn-sm" onClick={() => setSigOpen(true)}>{sig ? '重新簽名' : '建立簽名'}</button>}
          {tool === 'image' && (
            <label className="btn btn-sm cursor-pointer">選擇圖片
              <input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={async (e) => {
                const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
                const bmp = await createImageBitmap(f); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d')!.drawImage(bmp, 0, 0);
                const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
                setImg({ png: new Uint8Array(await blob.arrayBuffer()), w: bmp.width, h: bmp.height, url: '' }); bmp.close?.();
              }} /></label>
          )}
          <span className="flex-1" />
          <button className="btn btn-sm" onClick={undo} disabled={!history.length}>↶ 復原</button>
          <button className="btn btn-sm" disabled={!sel} onClick={() => { commit({ ...anns, [page]: list.filter((a) => a.id !== sel) }); setSel(null); }}>🗑 刪除</button>
          {selected && (selected.t === 'text' || selected.t === 'note') && <button className="btn btn-sm" onClick={() => setPopup({ kind: selected.t as any, x: 0, y: 0, value: (selected as any).text, editId: selected.id })}>編輯內容</button>}
          <span className="chip">共 {total} 個標記</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <PageNav page={page} total={pageCount} onChange={(p) => { setPage(p); setSel(null); }} />
        <div className="flex items-center gap-1">
          <button className="btn btn-sm" onClick={() => { setFit(false); setScale((s) => Math.max(0.3, s - 0.15)); }}>－</button>
          <span className="w-12 text-center text-xs">{Math.round(scale * 100)}%</span>
          <button className="btn btn-sm" onClick={() => { setFit(false); setScale((s) => Math.min(3, s + 0.15)); }}>＋</button>
          <button className={`btn btn-sm ${fit ? 'btn-primary' : ''}`} onClick={() => setFit(true)}>符合寬度</button>
        </div>
      </div>
      <div ref={wrap} className="overflow-auto rounded-lg bg-slate-200 p-3 dark:bg-slate-800" style={{ maxHeight: '75vh' }}>
        <PageStage pdf={pdf} pageIndex={page} scale={scale} night={night}
          lockTouch={tool !== 'select' || !!sel} cursor={tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair'}
          onDown={onDown} onMove={onMove} onUp={onUp}>
          {({ width: W, height: H, scale: s }) => (
            <>
              <svg className="pointer-events-none absolute inset-0" width={W * s} height={H * s} viewBox={`0 0 ${W} ${H}`}>{svgShapes(list)}{draft && svgShapes([draft])}</svg>
              {list.map((a) => render(a, s, a.id))}
              {draft && render(draft, s, 'draft', true)}
              {popup && !popup.editId && (
                <div className="absolute z-10 w-64 rounded-lg border bg-white p-2 shadow-lg dark:bg-slate-900" style={{ left: Math.min(popup.x * s, W * s - 270), top: popup.y * s }} onPointerDown={(e) => e.stopPropagation()}>
                  <textarea autoFocus className="input !text-sm" rows={3} value={popup.value} placeholder={popup.kind === 'text' ? '輸入文字…' : '便利貼內容…'} onChange={(e) => setPopup({ ...popup, value: e.target.value })} />
                  <div className="mt-2 flex justify-end gap-2"><button className="btn btn-sm" onClick={() => setPopup(null)}>取消</button><button className="btn btn-primary btn-sm" onClick={addPopup}>加入</button></div>
                </div>
              )}
            </>
          )}
        </PageStage>
      </div>
      {popup?.editId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3"><div className="card w-full max-w-md space-y-2">
          <textarea autoFocus className="input" rows={4} value={popup.value} onChange={(e) => setPopup({ ...popup, value: e.target.value })} />
          <div className="flex justify-end gap-2"><button className="btn" onClick={() => setPopup(null)}>取消</button><button className="btn btn-primary" onClick={addPopup}>儲存</button></div>
        </div></div>
      )}
      {sigOpen && <SignaturePad onCancel={() => setSigOpen(false)} onDone={(png, w, h) => { setSig({ png, w, h }); setSigOpen(false); setTool('signature'); }} />}
    </div>
  );
}
