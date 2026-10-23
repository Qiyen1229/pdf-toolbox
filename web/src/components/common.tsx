import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { PDFDocument, EncryptedPDFError } from 'pdf-lib';
import JSZip from 'jszip';
import { ACCEPT_PDF, canShareFiles, downloadBytes, formatSize, isPdfBytes, mimeFor, readBytes, shareBytes, MAX_RECOMMENDED } from '../lib/files';
import { openPdf, renderPage, freeCanvas, destroyPdf, type PDFDocumentProxy } from '../lib/pdfjs';
import { reportUsage, errorText } from '../lib/api';

// ---------- 小元件 ----------
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint mt-1 block">{hint}</span>}
    </label>
  );
}
export function Alert({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const c = { info: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100',
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
    error: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100',
    ok: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100' }[kind];
  return <div role={kind === 'error' ? 'alert' : undefined} className={`rounded-lg border px-3 py-2 text-sm ${c}`}>{children}</div>;
}
export function ProgressBar({ done, total, label }: { done: number; total: number; label?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-1" aria-live="polite">
      <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300"><span>{label ?? '處理中…'}</span><span>{total ? `${done}/${total}` : ''}</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={`h-full rounded-full bg-brand-600 transition-all ${total ? '' : 'w-1/3 animate-pulse'}`} style={total ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}
export const Spinner = () => <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />;

// ---------- 檔案選取 ----------
export function FileDrop({ accept, multiple, onFiles, label, compact }: { accept: string; multiple?: boolean; onFiles: (f: File[]) => void; label?: string; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = [...e.dataTransfer.files]; if (f.length) onFiles(multiple ? f : f.slice(0, 1)); }}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed text-center transition ${compact ? 'p-4' : 'p-8'} ${over ? 'border-brand-500 bg-brand-50 dark:bg-brand-600/10' : 'border-slate-300 hover:border-brand-500 dark:border-slate-600'}`}
      onClick={() => input.current?.click()}
      role="button" tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
    >
      <div className="text-3xl" aria-hidden>📄</div>
      <div className="mt-1 text-sm font-medium">{label ?? (multiple ? '點擊選擇檔案，或拖放到此處' : '點擊選擇檔案，或拖放到此處')}</div>
      <div className="hint mt-0.5">支援「檔案」App、相簿與拖放；檔案不會離開你的裝置</div>
      <input ref={input} type="file" hidden accept={accept} multiple={multiple}
        onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) onFiles(f); }} />
    </div>
  );
}

// ---------- PDF 來源（含密碼處理） ----------
export interface PdfSource { name: string; bytes: Uint8Array; pages: number; originalSize: number; wasEncrypted: boolean }

export async function loadSource(file: File, password?: string): Promise<PdfSource> {
  let bytes = await readBytes(file);
  if (!isPdfBytes(bytes)) throw new Error(`「${file.name}」不是有效的 PDF 檔案（檔頭驗證失敗）`);
  if (bytes.length > MAX_RECOMMENDED) console.warn('large file');
  let wasEncrypted = false;
  try {
    const d = await PDFDocument.load(bytes, { updateMetadata: false });
    return { name: file.name, bytes, pages: d.getPageCount(), originalSize: bytes.length, wasEncrypted };
  } catch (e) {
    if (!(e instanceof EncryptedPDFError) && !/encrypted/i.test(String((e as any)?.message))) {
      throw new Error(`無法讀取「${file.name}」：檔案可能已損毀。可先使用「修復 PDF」工具。（${(e as any)?.message ?? e}）`);
    }
  }
  // 加密檔：需要密碼 → 以 qpdf-wasm 在記憶體中解密
  if (password === undefined) throw Object.assign(new Error('needs_password'), { needsPassword: true });
  const { decryptPdf } = await import('../tools/qpdf');
  bytes = await decryptPdf(bytes, password);
  wasEncrypted = true;
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  return { name: file.name, bytes, pages: d.getPageCount(), originalSize: file.size, wasEncrypted };
}

export function PdfPicker({ value, onChange, label = '選擇 PDF 檔案', accept = ACCEPT_PDF }: { value: PdfSource | null; onChange: (s: PdfSource | null) => void; label?: string; accept?: string }) {
  const [pending, setPending] = useState<File | null>(null);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (f: File, password?: string) => {
    setBusy(true); setErr('');
    try { onChange(await loadSource(f, password)); setPending(null); setPw(''); }
    catch (e: any) {
      if (e?.needsPassword) setPending(f);
      else if (pending) setErr('密碼不正確或無法解密：' + e.message);
      else setErr(e.message);
    } finally { setBusy(false); }
  };

  if (pending) {
    return (
      <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); void load(pending, pw); }}>
        <div className="text-sm font-medium">🔒 「{pending.name}」已加密，請輸入開啟密碼</div>
        <input type="password" autoFocus className="input" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="密碼（僅在本機用於解密，不會上傳）" autoComplete="off" />
        {err && <Alert kind="error">{err}</Alert>}
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={busy || !pw}>{busy ? <Spinner /> : null} 解鎖</button>
          <button type="button" className="btn" disabled={busy} title="檔案只有「權限限制」而沒有開啟密碼時" onClick={() => void load(pending, '')}>無開啟密碼</button>
          <button type="button" className="btn" onClick={() => { setPending(null); setErr(''); }}>取消</button>
        </div>
      </form>
    );
  }
  if (value) {
    return (
      <div className="card flex flex-wrap items-center gap-3">
        <div className="text-2xl" aria-hidden>📕</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{value.name}</div>
          <div className="hint">{value.pages} 頁 · {formatSize(value.originalSize)}{value.wasEncrypted ? ' · 已在記憶體中解密' : ''}</div>
        </div>
        <button className="btn btn-sm" onClick={() => onChange(null)}>更換檔案</button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <FileDrop accept={accept} label={label} onFiles={(f) => void load(f[0])} />
      {busy && <ProgressBar done={0} total={0} label="讀取檔案…" />}
      {err && <Alert kind="error">{err}</Alert>}
    </div>
  );
}

// ---------- pdf.js 文件 hook ----------
export function usePdfDoc(bytes: Uint8Array | null) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false; let d: PDFDocumentProxy | null = null;
    setDoc(null); setError('');
    if (!bytes) return;
    openPdf(bytes).then((x) => { if (cancelled) void destroyPdf(x); else { d = x; setDoc(x); } }).catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; if (d) void destroyPdf(d); };
  }, [bytes]);
  return { doc, error };
}

/** 懶載入縮圖：進入視窗才渲染，離開不保留 canvas 記憶體。 */
export function PageThumb({ pdf, index, width = 140, rotate = 0, className = '' }: { pdf: PDFDocumentProxy; index: number; width?: number; rotate?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [vis, setVis] = useState(false);
  const [ratio, setRatio] = useState(1.414);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => setVis(e.isIntersecting), { rootMargin: '300px' });
    io.observe(el); return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!vis) return;
    let dead = false;
    (async () => {
      const page = await pdf.getPage(index + 1);
      const vp = page.getViewport({ scale: 1 });
      if (dead) return;
      setRatio(vp.height / vp.width);
      const c = ref.current; if (!c) return;
      await renderPage(page, ((width * (window.devicePixelRatio > 1 ? 1.5 : 1)) / vp.width), c);
      page.cleanup();
    })().catch(() => {});
    return () => { dead = true; };
  }, [vis, pdf, index, width]);
  useEffect(() => () => { if (ref.current) freeCanvas(ref.current); }, []);
  const r = ((rotate % 360) + 360) % 360;
  return (
    <div ref={wrap} className={`overflow-hidden rounded bg-white ${className}`} style={{ width, height: (r % 180 ? width / ratio : width * ratio) }}>
      <canvas ref={ref} style={{ width, height: width * ratio, transform: `rotate(${r}deg)${r % 180 ? ` scale(${1 / ratio})` : ''}`, transformOrigin: 'center', display: 'block', margin: r % 180 ? `${(width / ratio - width * ratio) / 2}px auto` : undefined }} className="pdf-page-shadow" />
    </div>
  );
}

// ---------- 輸出 ----------
export interface Output { name: string; data: Uint8Array | Blob; mime?: string; note?: string }
export function Outputs({ items, beforeSize, onClear }: { items: Output[]; beforeSize?: number; onClear?: () => void }) {
  const [zipping, setZipping] = useState(false);
  const [msg, setMsg] = useState('');
  const size = (o: Output) => (o.data instanceof Blob ? o.data.size : o.data.length);
  const total = items.reduce((s, o) => s + size(o), 0);
  const share = async (o: Output) => {
    try { if (!(await shareBytes(o.data, o.name, o.mime ?? mimeFor(o.name)))) { if (!canShareFiles()) setMsg('此瀏覽器不支援分享檔案，請使用「下載」。'); } }
    catch (e: any) { setMsg(e.message); }
  };
  const zipAll = async () => {
    setZipping(true);
    try {
      const z = new JSZip();
      for (const o of items) z.file(o.name, o.data);
      const blob = await z.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      downloadBytes(blob, 'pdf-toolbox-output.zip', 'application/zip');
    } finally { setZipping(false); }
  };
  if (!items.length) return null;
  return (
    <div className="card space-y-3 border-emerald-300 dark:border-emerald-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">✅ 完成 · {items.length} 個檔案 · {formatSize(total)}</div>
        {beforeSize !== undefined && items.length === 1 && (
          <div className="chip">{formatSize(beforeSize)} → {formatSize(total)}（{total <= beforeSize ? '−' : '+'}{Math.abs(Math.round((1 - total / beforeSize) * 100))}%）</div>
        )}
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((o, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{o.name}</div>
              <div className="hint">{formatSize(size(o))}{o.note ? ` · ${o.note}` : ''}</div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => downloadBytes(o.data, o.name, o.mime ?? mimeFor(o.name))}>下載</button>
            {canShareFiles() && <button className="btn btn-sm" onClick={() => void share(o)}>分享 / 存到檔案</button>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {items.length > 1 && <button className="btn" disabled={zipping} onClick={() => void zipAll()}>{zipping ? <Spinner /> : '📦'} 全部打包為 ZIP</button>}
        {onClear && <button className="btn btn-ghost btn-sm" onClick={onClear}>清除結果</button>}
      </div>
      {msg && <Alert kind="warn">{msg}</Alert>}
    </div>
  );
}

// ---------- 執行器 ----------
export interface Report { (done: number, total: number, label?: string): void }
export function useRunner(toolId: string) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label?: string } | null>(null);
  const [error, setError] = useState('');
  const [outputs, setOutputs] = useState<Output[]>([]);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const run = useCallback(async (fn: (report: Report) => Promise<Output[] | void>, meta?: { bytes?: number }) => {
    setBusy(true); setError(''); setOutputs([]); setProgress({ done: 0, total: 0 });
    try {
      const res = await fn((done, total, label) => alive.current && setProgress({ done, total, label }));
      if (!alive.current) return;
      if (res) setOutputs(res);
      reportUsage(toolId, meta?.bytes);
    } catch (e: any) {
      if (alive.current) setError(errorText(e));
    } finally { if (alive.current) { setBusy(false); setProgress(null); } }
  }, [toolId]);
  return { run, busy, progress, error, outputs, setOutputs, setError };
}

export function RunStatus({ r }: { r: ReturnType<typeof useRunner> }) {
  return (
    <>
      {r.busy && r.progress && <ProgressBar {...r.progress} />}
      {r.error && <Alert kind="error">{r.error}</Alert>}
    </>
  );
}

export const outName = (src: string, suffix: string, ext = 'pdf') => `${src.replace(/\.[^.]+$/, '')}${suffix}.${ext}`;
