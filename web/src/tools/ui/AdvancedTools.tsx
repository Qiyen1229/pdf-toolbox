import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { Alert, Field, FileDrop, Outputs, PdfPicker, RunStatus, Spinner, loadSource, outName, useRunner, usePdfDoc, type PdfSource } from '../../components/common';
import { PageNav, PageStage, type Pt } from '../../components/PageStage';
import { extractText, type PageText } from '../convert';
import { ocrPdf, ocrImage, OCR_LANGS } from '../ocr';
import { writeBookmarks, listLinks, addLink, removeLinks, docInfo, type Bookmark, type LinkInfo, type DocInfo } from '../ops/structure';
import { readMetadata, stripMetadata, rotatePdf } from '../ops/pdf';
import { stampPages, watermark } from '../ops/stamp';
import { comparePages, compressImages, type PageDiff } from '../raster';
import { diffText, type DiffPart } from '../textdiff';
import { encryptPdf, ALL_ALLOWED } from '../qpdf';
import { flattenForm } from '../ops/forms';
import { renderTextImage } from '../../lib/textImage';
import { formatSize, sniffImage, readBytes, stripExt } from '../../lib/files';
import { reportUsage } from '../../lib/api';
import { openPdf, destroyPdf } from '../../lib/pdfjs';

// ================= 文字擷取 =================
export function ExtractText({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [pages, setPages] = useState<PageText[]>([]);
  const [copied, setCopied] = useState(-1);
  const r = useRunner(id);
  useEffect(() => {
    setPages([]); if (!src) return;
    void r.run(async (rep) => { setPages(await extractText(src.bytes, {}, rep)); }, { bytes: src.originalSize });
  }, [src]);
  const all = pages.map((p) => p.text).join('\n\n');
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={setSrc} />
      <RunStatus r={r} />
      {pages.length > 0 && (
        <>
          {!all.trim() && <Alert kind="warn">沒有擷取到文字，這可能是掃描檔。請使用「OCR 文字辨識」。</Alert>}
          <div className="flex gap-2">
            <button className="btn btn-sm" onClick={() => { void navigator.clipboard.writeText(all); setCopied(-2); }}>{copied === -2 ? '已複製 ✓' : '複製全部'}</button>
          </div>
          {pages.map((p, i) => (
            <div key={p.page} className="card">
              <div className="mb-1 flex items-center justify-between"><span className="text-xs font-semibold text-slate-500">第 {p.page} 頁</span>
                <button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard.writeText(p.text); setCopied(i); }}>{copied === i ? '已複製 ✓' : '複製'}</button></div>
              <pre className="whitespace-pre-wrap break-words text-sm">{p.text || '（本頁沒有文字）'}</pre>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ================= 全文檢索 =================
interface IndexedDoc { name: string; pages: PageText[] }
export function Search({ id }: { id: string }) {
  const [docs, setDocs] = useState<IndexedDoc[]>([]);
  const [q, setQ] = useState('');
  const [regex, setRegex] = useState(false);
  const [cs, setCs] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const add = async (files: File[]) => {
    setErr('');
    for (const f of files) {
      setBusy(`建立索引：${f.name}`);
      try { const s = await loadSource(f); setDocs((d) => [...d, { name: f.name, pages: [] }]); const pages = await extractText(s.bytes); setDocs((d) => d.map((x) => (x.name === f.name && !x.pages.length ? { ...x, pages } : x))); reportUsage(id, s.originalSize); }
      catch (e: any) { setErr(e.message); }
    }
    setBusy('');
  };
  const results = useMemo(() => {
    if (!q.trim()) return [];
    let re: RegExp;
    try { re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'g' : 'gi'); } catch { return []; }
    const out: { doc: string; page: number; before: string; hit: string; after: string }[] = [];
    for (const d of docs) for (const p of d.pages) {
      re.lastIndex = 0; let m: RegExpExecArray | null; let n = 0;
      while ((m = re.exec(p.text)) && n++ < 20) {
        if (!m[0]) { re.lastIndex++; continue; }
        out.push({ doc: d.name, page: p.page, before: p.text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, ' '), hit: m[0], after: p.text.slice(m.index + m[0].length, m.index + m[0].length + 60).replace(/\s+/g, ' ') });
      }
    }
    return out.slice(0, 500);
  }, [docs, q, regex, cs]);
  return (
    <div className="space-y-4">
      <FileDrop accept="application/pdf,.pdf" multiple compact={docs.length > 0} label="加入要檢索的 PDF（可多份）" onFiles={(f) => void add(f)} />
      {busy && <Alert kind="info"><Spinner /> {busy}</Alert>}
      {err && <Alert kind="error">{err}</Alert>}
      {docs.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1.5">{docs.map((d) => <span key={d.name} className="chip">{d.name}（{d.pages.length} 頁）<button className="ml-1" onClick={() => setDocs((a) => a.filter((x) => x !== d))} aria-label="移除">✕</button></span>)}</div>
          <div className="card space-y-2">
            <input className="input" autoFocus placeholder="輸入關鍵字…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="flex gap-4 text-sm"><label><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> 正規表達式</label><label><input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} /> 區分大小寫</label></div>
          </div>
          {q && <div className="hint">{results.length} 個結果{results.length >= 500 ? '（僅顯示前 500 筆）' : ''}</div>}
          <ul className="space-y-1.5">
            {results.map((x, i) => <li key={i} className="card !p-2.5 text-sm"><div className="hint">{x.doc} · 第 {x.page} 頁</div>
              <div>…{x.before}<mark className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-600/50 dark:text-white">{x.hit}</mark>{x.after}…</div></li>)}
          </ul>
          <p className="hint">索引只存在於這個分頁的記憶體中，關閉或重新整理即清除。</p>
        </>
      )}
    </div>
  );
}

// ================= OCR =================
export function Ocr({ id }: { id: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [langs, setLangs] = useState<string[]>(['chi_tra', 'eng']);
  const [dpi, setDpi] = useState(200);
  const [pages, setPages] = useState('');
  const [text, setText] = useState('');
  const r = useRunner(id);
  const isImage = file && !/pdf$/i.test(file.type + file.name);
  return (
    <div className="space-y-4">
      {!file ? (
        <FileDrop accept="application/pdf,.pdf,image/*" label="選擇掃描的 PDF 或圖片" onFiles={async (f) => {
          const x = f[0]; setFile(x); r.setOutputs([]); setText('');
          if (/pdf$/i.test(x.type + x.name)) { try { setSrc(await loadSource(x)); } catch (e: any) { r.setError(e.message); setFile(null); } } else setSrc(null);
        }} />
      ) : (
        <div className="card flex items-center gap-3"><div className="min-w-0 flex-1 truncate text-sm">{file.name}{src ? ` · ${src.pages} 頁` : ''}</div><button className="btn btn-sm" onClick={() => { setFile(null); setSrc(null); r.setOutputs([]); }}>更換</button></div>
      )}
      {file && (
        <div className="card space-y-3">
          <div><span className="label">辨識語言（可複選，越多越慢）</span>
            <div className="flex flex-wrap gap-2">{OCR_LANGS.map((l) => (
              <label key={l.id} className={`btn btn-sm cursor-pointer ${langs.includes(l.id) ? 'btn-primary' : ''}`}>
                <input hidden type="checkbox" checked={langs.includes(l.id)} onChange={() => setLangs((a) => (a.includes(l.id) ? a.filter((x) => x !== l.id) : [...a, l.id]))} />{l.label}</label>))}</div></div>
          {!isImage && <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`渲染解析度 ${dpi} DPI`} hint="越高越準確但越慢；iOS 建議 150–200"><input type="range" min={100} max={300} step={25} value={dpi} onChange={(e) => setDpi(+e.target.value)} className="w-full" /></Field>
            <Field label="頁碼範圍" hint="留空 = 全部"><input className="input" value={pages} onChange={(e) => setPages(e.target.value)} /></Field></div>}
          <button className="btn btn-primary" disabled={r.busy || !langs.length} onClick={() => r.run(async (rep) => {
            if (isImage) { rep(0, 0, '辨識中…'); const t = await ocrImage(await readBytes(file), langs); setText(t); return [{ name: `${stripExt(file.name)}.txt`, data: new TextEncoder().encode(t), mime: 'text/plain' }]; }
            const res = await ocrPdf(src!.bytes, { langs, dpi, pages }, rep);
            setText(res.text);
            return [{ name: outName(src!.name, '_ocr'), data: res.pdf, note: '可搜尋 PDF' }, { name: outName(src!.name, '_ocr', 'txt'), data: new TextEncoder().encode(res.text), mime: 'text/plain' }];
          }, { bytes: file.size })}>{r.busy ? <Spinner /> : '👁️'} 開始辨識</button>
          <p className="hint">語言資料由本站自行託管（不連外），首次使用時下載後會快取供離線使用。</p>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
      {text && <pre className="card max-h-80 overflow-auto whitespace-pre-wrap text-sm">{text}</pre>}
      <Alert kind="warn">OCR 準確度受掃描品質、字體、傾斜與排版影響；請務必人工校對重要內容。手寫字與直排文字辨識率較低。輸出 PDF 由頁面影像重建（文件會以影像為底並加上隱形文字層）。</Alert>
    </div>
  );
}

// ================= 書籤 =================
interface BRow { id: string; title: string; page: number; level: number }
function toTree(rows: BRow[]): Bookmark[] {
  const root: Bookmark[] = []; const stack: { level: number; list: Bookmark[] }[] = [{ level: -1, list: root }];
  for (const r of rows) {
    while (stack.length > 1 && stack[stack.length - 1].level >= r.level) stack.pop();
    const node: Bookmark = { title: r.title, page: r.page, children: [] };
    stack[stack.length - 1].list.push(node);
    stack.push({ level: r.level, list: node.children! });
  }
  const clean = (l: Bookmark[]): Bookmark[] => l.map((n) => ({ title: n.title, page: n.page, children: n.children?.length ? clean(n.children) : undefined }));
  return clean(root);
}
export function Bookmarks({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const { doc } = usePdfDoc(src?.bytes ?? null);
  const [rows, setRows] = useState<BRow[]>([]);
  const r = useRunner(id);
  useEffect(() => {
    if (!doc) return setRows([]);
    (async () => {
      const outline = await doc.getOutline();
      const out: BRow[] = [];
      const walk = async (items: any[], level: number) => {
        for (const it of items) {
          let page = 0;
          try {
            const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
            if (dest?.[0]) page = typeof dest[0] === 'object' ? await doc.getPageIndex(dest[0]) : Number(dest[0]);
          } catch { /* 無法解析的目的地 */ }
          out.push({ id: crypto.randomUUID(), title: it.title, page, level });
          if (it.items?.length) await walk(it.items, level + 1);
        }
      };
      if (outline) await walk(outline, 0);
      setRows(out);
    })();
  }, [doc]);
  const upd = (i: string, p: Partial<BRow>) => setRows((a) => a.map((x) => (x.id === i ? { ...x, ...p } : x)));
  const move = (i: number, d: number) => setRows((a) => { const b = [...a]; const [x] = b.splice(i, 1); b.splice(i + d, 0, x); return b; });
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between"><span className="text-sm font-semibold">{rows.length ? `${rows.length} 個書籤` : '此文件沒有書籤'}</span>
            <button className="btn btn-sm" onClick={() => setRows((a) => [...a, { id: crypto.randomUUID(), title: '新書籤', page: 0, level: 0 }])}>＋ 新增</button></div>
          <ul className="space-y-1.5">
            {rows.map((b, i) => (
              <li key={b.id} className="flex flex-wrap items-center gap-1.5" style={{ paddingLeft: b.level * 20 }}>
                <input className="input !min-h-8 min-w-40 flex-1" value={b.title} onChange={(e) => upd(b.id, { title: e.target.value })} aria-label="標題" />
                <input type="number" min={1} max={src.pages} className="input !min-h-8 !w-20" value={b.page + 1} onChange={(e) => upd(b.id, { page: Math.min(src.pages, Math.max(1, +e.target.value)) - 1 })} aria-label="頁碼" />
                <button className="btn btn-sm !px-2" onClick={() => upd(b.id, { level: Math.max(0, b.level - 1) })} title="升階">⇤</button>
                <button className="btn btn-sm !px-2" onClick={() => upd(b.id, { level: Math.min(5, b.level + 1) })} title="降階">⇥</button>
                <button className="btn btn-sm !px-2" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="btn btn-sm !px-2" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn btn-sm !px-2" onClick={() => setRows((a) => a.filter((x) => x.id !== b.id))}>🗑</button>
              </li>
            ))}
          </ul>
          <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async () => [{ name: outName(src.name, '_bookmarks'), data: await writeBookmarks(src.bytes, toTree(rows)) }], { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '💾'} 儲存書籤</button>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

// ================= 超連結 =================
export function Links({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const { doc } = usePdfDoc(src?.bytes ?? null);
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const [page, setPage] = useState(0);
  const [url, setUrl] = useState('https://');
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<Pt | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const r = useRunner(id);
  useEffect(() => { setBytes(src?.bytes ?? null); setRect(null); }, [src]);
  useEffect(() => { if (bytes) listLinks(bytes).then(setLinks).catch(() => setLinks([])); else setLinks([]); }, [bytes]);
  const norm = (a: Pt, b: Pt) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  const apply = (fn: () => Promise<Uint8Array>) => r.run(async () => { const out = await fn(); setBytes(out); return [{ name: outName(src!.name, '_links'), data: out }]; }, { bytes: src?.originalSize });
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && bytes && (
        <>
          <div className="card space-y-2">
            <div className="text-sm font-semibold">現有連結（{links.length}）</div>
            {links.length === 0 && <div className="hint">沒有連結</div>}
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {links.map((l) => (
                <li key={`${l.page}-${l.index}`} className="flex items-center gap-2 py-1.5 text-sm">
                  <span className="chip">第 {l.page + 1} 頁</span><span className="min-w-0 flex-1 truncate">{l.kind === 'uri' ? l.target : l.kind === 'internal' ? '（文件內跳轉）' : '（其他動作）'}</span>
                  <button className="btn btn-sm" onClick={() => void apply(() => removeLinks(bytes, [{ page: l.page, index: l.index }]))}>移除</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="card space-y-3">
            <div className="text-sm font-semibold">新增連結</div>
            <div className="flex flex-wrap items-center gap-2"><PageNav page={page} total={src.pages} onChange={(p) => { setPage(p); setRect(null); }} />
              <input className="input min-w-52 flex-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" /></div>
            {doc && <div className="overflow-auto rounded-lg bg-slate-200 p-3 dark:bg-slate-800" style={{ maxHeight: '60vh' }}>
              <PageStage pdf={doc} pageIndex={page} scale={0.9} lockTouch cursor="crosshair" onDown={(p) => { setDrag(p); setRect({ x: p.x, y: p.y, w: 0, h: 0 }); }}
                onMove={(p) => drag && setRect(norm(drag, p))} onUp={(p) => { if (drag) setRect(norm(drag, p)); setDrag(null); }}>
                {({ scale }) => rect && <div className="absolute border-2 border-blue-600 bg-blue-500/20" style={{ left: rect.x * scale, top: rect.y * scale, width: rect.w * scale, height: rect.h * scale }} />}
              </PageStage></div>}
            <button className="btn btn-primary" disabled={r.busy || !rect || rect.w < 5 || rect.h < 5} onClick={() => void apply(async () => {
              const tmp = await openPdf(bytes);
              try {
                const vp = (await tmp.getPage(page + 1)).getViewport({ scale: 1 });
                // 視覺座標 → 使用者空間：由 pdf.js viewport 轉換（已含旋轉）
                const [x1, y1] = vp.convertToPdfPoint(rect!.x, rect!.y), [x2, y2] = vp.convertToPdfPoint(rect!.x + rect!.w, rect!.y + rect!.h);
                return await addLink(bytes, page, [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)], url);
              } finally { await destroyPdf(tmp); }
            })}>＋ 在選取區域加入連結</button>
          </div>
        </>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

// ================= 比較 =================
function Overlay({ canvas }: { canvas?: HTMLCanvasElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (!el || !canvas) return; canvas.style.width = '100%'; canvas.style.height = 'auto'; el.replaceChildren(canvas); }, [canvas]);
  return <div ref={ref} className="overflow-hidden rounded border" />;
}
export function Compare({ id }: { id: string }) {
  const [a, setA] = useState<PdfSource | null>(null), [b, setB] = useState<PdfSource | null>(null);
  const [diffs, setDiffs] = useState<PageDiff[]>([]);
  const [textDiffs, setTextDiffs] = useState<{ page: number; parts: DiffPart[]; changed: boolean }[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const r = useRunner(id);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div><div className="label">原始版本 (A)</div><PdfPicker value={a} onChange={(s) => { setA(s); setDiffs([]); }} /></div>
        <div><div className="label">新版本 (B)</div><PdfPicker value={b} onChange={(s) => { setB(s); setDiffs([]); }} /></div>
      </div>
      {a && b && <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async (rep) => {
        const [ta, tb] = [await extractText(a.bytes), await extractText(b.bytes)];
        const n = Math.max(ta.length, tb.length);
        const td = Array.from({ length: n }, (_, i) => { const parts = diffText(ta[i]?.text ?? '', tb[i]?.text ?? ''); return { page: i + 1, parts, changed: parts.some((p) => p.type !== 'same') }; });
        setTextDiffs(td);
        setDiffs(await comparePages(a.bytes, b.bytes, rep));
      }, { bytes: a.originalSize + b.originalSize })}>{r.busy ? <Spinner /> : '🆚'} 比較</button>}
      <RunStatus r={r} />
      {diffs.length > 0 && (
        <div className="space-y-3">
          <div className="card">
            <div className="text-sm">A：{a?.pages} 頁　B：{b?.pages} 頁　有差異頁面：<b>{diffs.filter((d) => d.changedRatio > 0.0005 || textDiffs[d.page - 1]?.changed).length}</b> / {diffs.length}</div>
          </div>
          {diffs.map((d, i) => {
            const td = textDiffs[i]; const changed = d.changedRatio > 0.0005 || td?.changed;
            return (
              <div key={d.page} className="card space-y-2">
                <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(open === i ? null : i)}>
                  <span className="text-sm font-medium">第 {d.page} 頁 {changed ? <span className="chip !bg-red-100 !text-red-800">有差異</span> : <span className="chip !bg-emerald-100 !text-emerald-800">相同</span>}</span>
                  <span className="hint">視覺差異 {(d.changedRatio * 100).toFixed(2)}%{d.sizeMismatch ? ' · 尺寸不同' : ''}</span>
                </button>
                {open === i && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div><div className="label">視覺差異（紅色 = 不同）</div><Overlay canvas={d.overlay} /></div>
                    <div><div className="label">文字差異</div>
                      <div className="max-h-96 overflow-auto whitespace-pre-wrap rounded border p-2 text-sm">
                        {td?.parts.map((p, k) => <span key={k} className={p.type === 'add' ? 'bg-emerald-200 text-emerald-900' : p.type === 'del' ? 'bg-red-200 text-red-900 line-through' : ''}>{p.text}</span>)}
                      </div></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ================= 文件資訊 =================
export function Info({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [info, setInfo] = useState<DocInfo | null>(null);
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof readMetadata>> | null>(null);
  useEffect(() => {
    setInfo(null); if (!src) return;
    reportUsage(id, src.originalSize);
    void docInfo(src.bytes).then(setInfo); void readMetadata(src.bytes).then(setMeta);
  }, [src, id]);
  const Row = ({ k, v }: { k: string; v: any }) => <tr><td className="w-40 text-slate-500">{k}</td><td>{v ?? '—'}</td></tr>;
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={setSrc} />
      {info && meta && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card"><table className="tbl"><tbody>
            <Row k="檔名" v={src!.name} /><Row k="檔案大小" v={formatSize(info.sizeBytes)} /><Row k="頁數" v={info.pages} /><Row k="PDF 版本" v={info.version} />
            <Row k="標題" v={meta.title} /><Row k="作者" v={meta.author} /><Row k="主旨" v={meta.subject} /><Row k="關鍵字" v={meta.keywords} />
            <Row k="建立程式" v={meta.creator} /><Row k="轉換程式" v={meta.producer} /><Row k="建立時間" v={meta.created?.toLocaleString()} /><Row k="修改時間" v={meta.modified?.toLocaleString()} />
            <Row k="表單欄位" v={info.formFields} /><Row k="註解數" v={info.annotations} /><Row k="含書籤" v={info.hasOutline ? '是' : '否'} /><Row k="含數位簽章" v={info.hasSignature ? '是' : '否'} />
            <Row k="曾加密" v={src!.wasEncrypted ? '是（已於記憶體解密）' : '否'} />
          </tbody></table></div>
          <div className="space-y-4">
            <div className="card"><div className="mb-1 text-sm font-semibold">頁面尺寸</div>{info.pageSizes.map((s, i) => <div key={i} className="text-sm">{s.w} × {s.h} pt（{(s.w / 72 * 25.4).toFixed(0)} × {(s.h / 72 * 25.4).toFixed(0)} mm）× {s.count} 頁</div>)}</div>
            <div className="card"><div className="mb-1 text-sm font-semibold">字型（{info.fonts.length}）</div>
              <ul className="max-h-48 overflow-auto text-sm">{info.fonts.map((f, i) => <li key={i}>{f.name} <span className="hint">{f.type}{f.embedded ? ' · 內嵌' : ' · 未內嵌'}</span></li>)}{!info.fonts.length && <li className="hint">無</li>}</ul></div>
            <div className="card"><div className="mb-1 text-sm font-semibold">內嵌影像（{info.images.length}）</div>
              <ul className="max-h-48 overflow-auto text-sm">{info.images.map((m, i) => <li key={i}>{m.width} × {m.height} <span className="hint">{m.filter} · {m.colorSpace}</span></li>)}{!info.images.length && <li className="hint">無</li>}</ul></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ================= 批次處理 =================
type BatchOp = 'compress' | 'strip' | 'rotate' | 'watermark' | 'pagenum' | 'encrypt' | 'flatten';
export function Batch({ id }: { id: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [op, setOp] = useState<BatchOp>('compress');
  const [text, setText] = useState('CONFIDENTIAL');
  const [angle, setAngle] = useState(90);
  const [pw, setPw] = useState('');
  const [level, setLevel] = useState<'high' | 'medium' | 'low'>('medium');
  const [log, setLog] = useState<{ name: string; ok: boolean; msg: string }[]>([]);
  const r = useRunner(id);
  const run = () => r.run(async (rep) => {
    setLog([]);
    const zip = new JSZip(); const lg: typeof log = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i]; rep(i + 1, files.length, f.name);
      try {
        const s = await loadSource(f);
        let out = s.bytes; let suffix = '';
        if (op === 'compress') { out = await compressImages(out, level); suffix = '_compressed'; }
        if (op === 'strip') { out = await stripMetadata(out); suffix = '_clean'; }
        if (op === 'rotate') { out = await rotatePdf(out, angle); suffix = '_rotated'; }
        if (op === 'watermark') { out = await watermark(out, { kind: 'text', text, style: { size: 48, color: [220, 38, 38], opacity: 0.25, font: 'Helvetica', bold: true }, rotate: 45, tile: false }, renderTextImage); suffix = '_watermark'; }
        if (op === 'pagenum') { out = await stampPages(out, { template: '{page} / {pages}', anchor: 'bc', margin: 24, style: { size: 10, color: [0, 0, 0], opacity: 1, font: 'Helvetica' } }, renderTextImage); suffix = '_numbered'; }
        if (op === 'encrypt') { out = await encryptPdf(out, { userPassword: pw, perms: ALL_ALLOWED }); suffix = '_encrypted'; }
        if (op === 'flatten') { out = await flattenForm(out); suffix = '_flattened'; }
        zip.file(outName(f.name, suffix), out);
        lg.push({ name: f.name, ok: true, msg: `${formatSize(s.originalSize)} → ${formatSize(out.length)}` });
      } catch (e: any) { lg.push({ name: f.name, ok: false, msg: e.message }); }
      setLog([...lg]);
    }
    if (!Object.keys(zip.files).length) throw new Error('所有檔案都處理失敗');
    return [{ name: 'batch-output.zip', data: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), mime: 'application/zip' }];
  }, { bytes: files.reduce((s, f) => s + f.size, 0) });
  return (
    <div className="space-y-4">
      <FileDrop accept="application/pdf,.pdf" multiple compact={files.length > 0} label="加入多個 PDF（受密碼保護的檔案不支援批次）" onFiles={(f) => setFiles((a) => [...a, ...f])} />
      {files.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1.5">{files.map((f, i) => <span key={i} className="chip">{f.name} · {formatSize(f.size)}<button className="ml-1" onClick={() => setFiles((a) => a.filter((_, k) => k !== i))} aria-label="移除">✕</button></span>)}</div>
          <div className="card space-y-3">
            <Field label="要套用的操作">
              <select className="input" value={op} onChange={(e) => setOp(e.target.value as BatchOp)}>
                <option value="compress">壓縮（重新壓縮影像）</option><option value="strip">移除中繼資料</option><option value="rotate">旋轉所有頁面</option>
                <option value="watermark">文字浮水印</option><option value="pagenum">加入頁碼</option><option value="encrypt">加密（AES-256）</option><option value="flatten">扁平化表單</option>
              </select>
            </Field>
            {op === 'compress' && <Field label="品質"><select className="input" value={level} onChange={(e) => setLevel(e.target.value as any)}><option value="high">高品質</option><option value="medium">平衡</option><option value="low">最小檔案</option></select></Field>}
            {op === 'rotate' && <Field label="角度"><select className="input" value={angle} onChange={(e) => setAngle(+e.target.value)}><option value={90}>順時針 90°</option><option value={180}>180°</option><option value={270}>逆時針 90°</option></select></Field>}
            {op === 'watermark' && <Field label="浮水印文字"><input className="input" value={text} onChange={(e) => setText(e.target.value)} /></Field>}
            {op === 'encrypt' && <Field label="開啟密碼（所有檔案相同）"><input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>}
            <button className="btn btn-primary" disabled={r.busy || (op === 'encrypt' && !pw)} onClick={() => void run()}>{r.busy ? <Spinner /> : '⚙️'} 處理 {files.length} 個檔案</button>
          </div>
        </>
      )}
      <RunStatus r={r} />
      {log.length > 0 && <ul className="card space-y-1 text-sm">{log.map((l, i) => <li key={i} className={l.ok ? '' : 'text-red-600'}>{l.ok ? '✓' : '✗'} {l.name} — {l.msg}</li>)}</ul>}
      <Outputs items={r.outputs} />
    </div>
  );
}
