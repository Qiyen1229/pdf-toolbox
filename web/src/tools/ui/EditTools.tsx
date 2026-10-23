import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Field, FileDrop, Outputs, PageThumb, PdfPicker, RunStatus, Spinner, loadSource, outName, useRunner, usePdfDoc, type PdfSource } from '../../components/common';
import { PageNav, PageStage } from '../../components/PageStage';
import { useAuth } from '../../lib/auth';
import { formatSize, stripExt } from '../../lib/files';
import { mergePdfs, splitPdf, rebuildPages, cropMargins, cropRect, resizePages, repairPdf, PAGE_SIZES, parseRanges, type PageSpec } from '../ops/pdf';
import { compressImages, compressRasterize, COMPRESS_PRESETS, type CompressLevel } from '../raster';
import { ocrAfterCompressHint } from './hints';

const arrMove = <T,>(a: T[], from: number, to: number) => { const b = [...a]; const [x] = b.splice(from, 1); b.splice(to, 0, x); return b; };

// ================= 合併 =================
interface MItem { key: string; file: File; src?: PdfSource; needPw?: boolean; pw: string; err?: string; range: string }
export function Merge({ id }: { id: string }) {
  const [items, setItems] = useState<MItem[]>([]);
  const r = useRunner(id);
  const upd = (key: string, p: Partial<MItem>) => setItems((a) => a.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const tryLoad = async (it: MItem, pw?: string) => {
    try { upd(it.key, { src: await loadSource(it.file, pw), needPw: false, err: undefined }); }
    catch (e: any) { upd(it.key, e?.needsPassword ? { needPw: true } : { err: e.message }); }
  };
  const add = (files: File[]) => {
    const news = files.map((f) => ({ key: crypto.randomUUID(), file: f, pw: '', range: '' }));
    setItems((a) => [...a, ...news]);
    news.forEach((n) => void tryLoad(n));
  };
  const ready = items.length >= 2 && items.every((i) => i.src);
  const total = items.reduce((s, i) => s + (i.src?.originalSize ?? 0), 0);
  return (
    <div className="space-y-4">
      <FileDrop accept="application/pdf,.pdf" multiple onFiles={add} label="加入要合併的 PDF（可一次選多個）" compact={items.length > 0} />
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={it.key} className="card flex flex-wrap items-center gap-2 !p-3">
              <span className="w-6 text-center text-xs text-slate-400">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{it.file.name}</div>
                <div className="hint">{it.src ? `${it.src.pages} 頁 · ${formatSize(it.src.originalSize)}` : it.err ?? (it.needPw ? '需要密碼' : '讀取中…')}</div>
                {it.needPw && (
                  <form className="mt-1 flex gap-2" onSubmit={(e) => { e.preventDefault(); void tryLoad(it, it.pw); }}>
                    <input type="password" className="input !min-h-8" placeholder="開啟密碼" value={it.pw} onChange={(e) => upd(it.key, { pw: e.target.value })} />
                    <button className="btn btn-sm">解鎖</button>
                  </form>
                )}
              </div>
              <input className="input !min-h-8 !w-28" placeholder="頁碼 如 1-3,5" value={it.range} onChange={(e) => upd(it.key, { range: e.target.value })} aria-label="頁碼範圍" />
              <button className="btn btn-sm" disabled={i === 0} onClick={() => setItems((a) => arrMove(a, i, i - 1))} aria-label="上移">↑</button>
              <button className="btn btn-sm" disabled={i === items.length - 1} onClick={() => setItems((a) => arrMove(a, i, i + 1))} aria-label="下移">↓</button>
              <button className="btn btn-sm" onClick={() => setItems((a) => a.filter((x) => x.key !== it.key))} aria-label="移除">✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={!ready || r.busy} onClick={() => r.run(async () => {
          const out = await mergePdfs(items.map((i) => ({ bytes: i.src!.bytes, pages: i.range })));
          return [{ name: 'merged.pdf', data: out }];
        }, { bytes: total })}>{r.busy ? <Spinner /> : '🧩'} 合併 {items.length || ''} 個檔案</button>
        {items.length === 1 && <span className="hint">至少需要 2 個檔案</span>}
      </div>
      <RunStatus r={r} />
      <Outputs items={r.outputs} beforeSize={total} />
    </div>
  );
}

// ================= 分割 =================
export function Split({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [mode, setMode] = useState<'ranges' | 'every' | 'single'>('ranges');
  const [ranges, setRanges] = useState('1-3;4-');
  const [n, setN] = useState(5);
  const r = useRunner(id);
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card space-y-3">
          <div className="flex flex-wrap gap-2">
            {([['ranges', '依頁碼範圍'], ['every', '每 N 頁'], ['single', '每頁一檔']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setMode(k)} className={`btn btn-sm ${mode === k ? 'btn-primary' : ''}`}>{l}</button>
            ))}
          </div>
          {mode === 'ranges' && <Field label="頁碼範圍" hint={`用「;」分隔多組輸出，例如 1-3;4-6;7-（共 ${src.pages} 頁）。也可擷取單頁：5`}><input className="input" value={ranges} onChange={(e) => setRanges(e.target.value)} /></Field>}
          {mode === 'every' && <Field label="每份頁數"><input type="number" min={1} className="input" value={n} onChange={(e) => setN(+e.target.value)} /></Field>}
          <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async () => {
            const parts = await splitPdf(src.bytes, mode === 'ranges' ? { mode, ranges } : mode === 'every' ? { mode, n } : { mode });
            return parts.map((p) => ({ name: `${stripExt(src.name)}_${p.name}.pdf`, data: p.bytes }));
          }, { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '✂️'} 開始分割</button>
        </div>
      )}
      <RunStatus r={r} />
      <Outputs items={r.outputs} />
    </div>
  );
}

// ================= 整理頁面 =================
interface PItem { id: string; src: number; rotate: number; blank?: { w: number; h: number } }
export function Organize({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const { doc } = usePdfDoc(src?.bytes ?? null);
  const [items, setItems] = useState<PItem[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const r = useRunner(id);
  useEffect(() => { setItems(src ? Array.from({ length: src.pages }, (_, i) => ({ id: crypto.randomUUID(), src: i, rotate: 0 })) : []); }, [src]);
  const patch = (pid: string, p: Partial<PItem>) => setItems((a) => a.map((x) => (x.id === pid ? { ...x, ...p } : x)));
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && doc && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-sm" onClick={() => setItems((a) => a.map((x) => ({ ...x, rotate: (x.rotate + 90) % 360 })))}>全部右轉 90°</button>
            <button className="btn btn-sm" onClick={() => setItems((a) => [...a].reverse())}>反轉順序</button>
            <button className="btn btn-sm" onClick={() => setItems((a) => [...a, { id: crypto.randomUUID(), src: 0, rotate: 0, blank: { w: 595.28, h: 841.89 } }])}>＋ 末尾加空白頁</button>
            <button className="btn btn-sm" onClick={() => setItems(Array.from({ length: src.pages }, (_, i) => ({ id: crypto.randomUUID(), src: i, rotate: 0 })))}>還原</button>
            <span className="hint ml-auto">{items.length} 頁 · 拖曳或使用 ◀ ▶ 調整順序</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {items.map((it, i) => (
              <div key={it.id} draggable onDragStart={() => setDragId(it.id)} onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragId && dragId !== it.id) { const from = items.findIndex((x) => x.id === dragId); setItems((a) => arrMove(a, from, i)); } setDragId(null); }}
                className={`card flex flex-col items-center gap-1.5 !p-2 ${dragId === it.id ? 'opacity-40' : ''}`}>
                <div className="flex h-44 w-full items-center justify-center overflow-hidden">
                  {it.blank ? <div className="flex h-40 w-28 items-center justify-center rounded border border-dashed text-xs text-slate-400">空白頁</div>
                    : <PageThumb pdf={doc} index={it.src} width={110} rotate={it.rotate} />}
                </div>
                <div className="text-xs text-slate-500">{i + 1}{it.blank ? '' : `（原 ${it.src + 1}）`}</div>
                <div className="flex flex-wrap justify-center gap-1">
                  <button className="btn btn-sm !px-2" disabled={i === 0} onClick={() => setItems((a) => arrMove(a, i, i - 1))} aria-label="往前">◀</button>
                  <button className="btn btn-sm !px-2" disabled={i === items.length - 1} onClick={() => setItems((a) => arrMove(a, i, i + 1))} aria-label="往後">▶</button>
                  <button className="btn btn-sm !px-2" onClick={() => patch(it.id, { rotate: (it.rotate + 270) % 360 })} aria-label="左轉">↺</button>
                  <button className="btn btn-sm !px-2" onClick={() => patch(it.id, { rotate: (it.rotate + 90) % 360 })} aria-label="右轉">↻</button>
                  <button className="btn btn-sm !px-2" title="複製" onClick={() => setItems((a) => { const b = [...a]; b.splice(i + 1, 0, { ...it, id: crypto.randomUUID() }); return b; })}>⧉</button>
                  <button className="btn btn-sm !px-2" title="在後面插入空白頁" onClick={() => setItems((a) => { const b = [...a]; b.splice(i + 1, 0, { id: crypto.randomUUID(), src: 0, rotate: 0, blank: { w: 595.28, h: 841.89 } }); return b; })}>＋</button>
                  <button className="btn btn-sm !px-2 text-red-600" onClick={() => setItems((a) => a.filter((x) => x.id !== it.id))} aria-label="刪除">🗑</button>
                </div>
              </div>
            ))}
          </div>
          <button className="btn btn-primary" disabled={r.busy || !items.length} onClick={() => r.run(async () => {
            const specs: PageSpec[] = items.map((x) => (x.blank ? { src: 0, blank: x.blank } : { src: x.src, rotate: x.rotate }));
            return [{ name: outName(src.name, '_organized'), data: await rebuildPages(src.bytes, specs) }];
          }, { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '💾'} 套用並輸出</button>
        </>
      )}
      <RunStatus r={r} />
      <Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

// ================= 裁切 =================
export function Crop({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const { doc } = usePdfDoc(src?.bytes ?? null);
  const [mode, setMode] = useState<'margins' | 'area'>('margins');
  const [m, setM] = useState({ top: 20, right: 20, bottom: 20, left: 20 });
  const [pages, setPages] = useState('');
  const [page, setPage] = useState(0);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [applyAll, setApplyAll] = useState(true);
  const r = useRunner(id);
  const norm = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); setRect(null); setPage(0); }} />
      {src && (
        <div className="card space-y-3">
          <div className="flex gap-2">
            <button className={`btn btn-sm ${mode === 'margins' ? 'btn-primary' : ''}`} onClick={() => setMode('margins')}>四邊邊界（pt）</button>
            <button className={`btn btn-sm ${mode === 'area' ? 'btn-primary' : ''}`} onClick={() => setMode('area')}>在頁面上框選</button>
          </div>
          {mode === 'margins' ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
                  <Field key={k} label={{ top: '上', right: '右', bottom: '下', left: '左' }[k]}>
                    <input type="number" min={0} className="input" value={m[k]} onChange={(e) => setM({ ...m, [k]: Math.max(0, +e.target.value) })} />
                  </Field>
                ))}
              </div>
              <Field label="套用頁面" hint="留空 = 全部頁面；例如 1-3,5"><input className="input" value={pages} onChange={(e) => setPages(e.target.value)} /></Field>
            </>
          ) : doc && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3"><PageNav page={page} total={src.pages} onChange={setPage} />
                <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} /> 套用到所有頁面</label></div>
              <div className="overflow-auto rounded-lg bg-slate-200 p-3 dark:bg-slate-800">
                <PageStage pdf={doc} pageIndex={page} scale={0.9} lockTouch cursor="crosshair"
                  onDown={(p) => { setDrag(p); setRect({ x: p.x, y: p.y, w: 0, h: 0 }); }}
                  onMove={(p) => drag && setRect(norm(drag, p))}
                  onUp={(p) => { if (drag) setRect(norm(drag, p)); setDrag(null); }}>
                  {({ scale }) => rect && <div className="absolute border-2 border-brand-600 bg-brand-500/10" style={{ left: rect.x * scale, top: rect.y * scale, width: rect.w * scale, height: rect.h * scale }} />}
                </PageStage>
              </div>
              <div className="hint">{rect && rect.w > 5 ? `選取區域：${rect.w.toFixed(0)} × ${rect.h.toFixed(0)} pt` : '拖曳以框選要保留的區域'}</div>
            </div>
          )}
          <button className="btn btn-primary" disabled={r.busy || (mode === 'area' && (!rect || rect.w < 10))} onClick={() => r.run(async () => {
            let out: Uint8Array;
            if (mode === 'margins') out = await cropMargins(src.bytes, m, pages);
            else {
              const rs: Record<number, typeof rect & object> = {};
              for (let i = 0; i < src.pages; i++) if (applyAll || i === page) rs[i] = rect!;
              out = await cropRect(src.bytes, rs);
            }
            return [{ name: outName(src.name, '_cropped'), data: out }];
          }, { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '🔲'} 裁切</button>
        </div>
      )}
      <RunStatus r={r} />
      <Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

// ================= 頁面大小 =================
export function Resize({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [size, setSize] = useState('A4');
  const [cw, setCw] = useState(210), [ch, setCh] = useState(297);
  const [orientation, setOri] = useState<'auto' | 'portrait' | 'landscape'>('auto');
  const [fit, setFit] = useState<'contain' | 'cover' | 'stretch'>('contain');
  const r = useRunner(id);
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card grid gap-3 sm:grid-cols-2">
          <Field label="目標尺寸">
            <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
              {Object.keys(PAGE_SIZES).map((k) => <option key={k}>{k}</option>)}<option value="custom">自訂（mm）</option>
            </select>
          </Field>
          {size === 'custom' && <div className="grid grid-cols-2 gap-2"><Field label="寬 mm"><input type="number" className="input" value={cw} onChange={(e) => setCw(+e.target.value)} /></Field><Field label="高 mm"><input type="number" className="input" value={ch} onChange={(e) => setCh(+e.target.value)} /></Field></div>}
          <Field label="方向"><select className="input" value={orientation} onChange={(e) => setOri(e.target.value as any)}><option value="auto">依原頁面</option><option value="portrait">直向</option><option value="landscape">橫向</option></select></Field>
          <Field label="內容縮放" hint="完整放入會留白；填滿會裁掉邊緣；拉伸會變形">
            <select className="input" value={fit} onChange={(e) => setFit(e.target.value as any)}><option value="contain">完整放入（留白）</option><option value="cover">填滿（可能裁切）</option><option value="stretch">拉伸</option></select>
          </Field>
          <div className="sm:col-span-2">
            <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async () => {
              const sz: [number, number] = size === 'custom' ? [cw * 72 / 25.4, ch * 72 / 25.4] : PAGE_SIZES[size];
              return [{ name: outName(src.name, `_${size}`), data: await resizePages(src.bytes, { size: sz, orientation, fit }) }];
            }, { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '📐'} 套用</button>
          </div>
        </div>
      )}
      <RunStatus r={r} />
      <Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

// ================= 壓縮 =================
export function Compress({ id }: { id: string }) {
  const { outputQuality } = useAuth();
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [level, setLevel] = useState<CompressLevel>(outputQuality === 'high' ? 'high' : outputQuality === 'small' ? 'low' : 'medium');
  const [dpi, setDpi] = useState(110);
  const [q, setQ] = useState(0.6);
  const r = useRunner(id);
  const opts: { k: CompressLevel; l: string; d: string }[] = [
    { k: 'lossless', l: '僅優化結構', d: '不改變任何內容，節省有限' },
    { k: 'high', l: COMPRESS_PRESETS.high.label, d: '影像 JPEG 品質 82%，最長邊 ≤ 2600 px' },
    { k: 'medium', l: COMPRESS_PRESETS.medium.label, d: '影像 JPEG 品質 65%，最長邊 ≤ 1800 px' },
    { k: 'low', l: COMPRESS_PRESETS.low.label, d: '影像 JPEG 品質 45%，最長邊 ≤ 1200 px' },
    { k: 'extreme', l: '全頁點陣化（最大壓縮）', d: '每頁轉成圖片：檔案最小，但文字不可選取（可再做 OCR）' },
  ];
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card space-y-3">
          <div className="grid gap-2">
            {opts.map((o) => (
              <label key={o.k} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${level === o.k ? 'border-brand-500 bg-brand-50 dark:bg-brand-600/10' : 'border-slate-200 dark:border-slate-700'}`}>
                <input type="radio" name="lvl" checked={level === o.k} onChange={() => setLevel(o.k)} className="mt-1" />
                <span><span className="block text-sm font-medium">{o.l}</span><span className="hint">{o.d}</span></span>
              </label>
            ))}
          </div>
          {level === 'extreme' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={`解析度 ${dpi} DPI`}><input type="range" min={60} max={200} step={10} value={dpi} onChange={(e) => setDpi(+e.target.value)} className="w-full" /></Field>
              <Field label={`JPEG 品質 ${Math.round(q * 100)}%`}><input type="range" min={0.3} max={0.9} step={0.05} value={q} onChange={(e) => setQ(+e.target.value)} className="w-full" /></Field>
            </div>
          )}
          <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async (rep) => {
            const out = level === 'extreme' ? await compressRasterize(src.bytes, { dpi, quality: q }, rep) : await compressImages(src.bytes, level, rep);
            // 若結果反而變大，保留原檔
            const better = out.length < src.bytes.length;
            return [{ name: outName(src.name, '_compressed'), data: better ? out : src.bytes, note: better ? undefined : '已是最佳狀態，維持原檔' }];
          }, { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '🗜️'} 壓縮</button>
          <p className="hint">{ocrAfterCompressHint}</p>
        </div>
      )}
      <RunStatus r={r} />
      <Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

// ================= 修復 =================
export function Repair({ id }: { id: string }) {
  const [file, setFile] = useState<File | null>(null);
  const r = useRunner(id);
  const [notes, setNotes] = useState<string[]>([]);
  return (
    <div className="space-y-4">
      {!file ? <FileDrop accept="application/pdf,.pdf" onFiles={(f) => { setFile(f[0]); r.setOutputs([]); setNotes([]); }} label="選擇可能損毀的 PDF" /> : (
        <div className="card flex items-center gap-3"><div className="min-w-0 flex-1 truncate text-sm">{file.name} · {formatSize(file.size)}</div><button className="btn btn-sm" onClick={() => setFile(null)}>更換</button></div>
      )}
      {file && (
        <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async () => {
          const res = await repairPdf(new Uint8Array(await file.arrayBuffer()));
          setNotes(res.notes);
          return [{ name: outName(file.name, '_repaired'), data: res.bytes }];
        }, { bytes: file.size })}>{r.busy ? <Spinner /> : '🩹'} 嘗試修復</button>
      )}
      {notes.map((n, i) => <Alert key={i} kind="ok">{n}</Alert>)}
      <RunStatus r={r} />
      <Outputs items={r.outputs} beforeSize={file?.size} />
      <Alert kind="warn">修復透過重建物件結構完成，僅能救回可讀取的頁面；加密或被截斷嚴重的檔案可能無法修復。</Alert>
    </div>
  );
}
