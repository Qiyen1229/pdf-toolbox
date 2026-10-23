import { useState } from 'react';
import { Alert, Field, FileDrop, Outputs, PdfPicker, RunStatus, Spinner, outName, useRunner, type PdfSource } from '../../components/common';
import { useAuth } from '../../lib/auth';
import { formatSize, readBytes, stripExt, ACCEPT_IMAGE } from '../../lib/files';
import { renderTextImage } from '../../lib/textImage';
import { pdfToImages, imagesToPdf } from '../raster';
import { extractText, toPlainText, toMarkdown, toHtml, toDocx, toXlsx, toPptx, textToPdf } from '../convert';
import { PAGE_SIZES } from '../ops/pdf';

const enc = (s: string) => new TextEncoder().encode(s);

export function PdfToImage({ id }: { id: string }) {
  const { outputQuality } = useAuth();
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [format, setFormat] = useState<'jpg' | 'png' | 'webp' | 'tiff'>('jpg');
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(outputQuality === 'high' ? 0.95 : outputQuality === 'small' ? 0.6 : 0.85);
  const [pages, setPages] = useState('');
  const r = useRunner(id);
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card grid gap-3 sm:grid-cols-2">
          <Field label="格式"><select className="input" value={format} onChange={(e) => setFormat(e.target.value as any)}><option value="jpg">JPG</option><option value="png">PNG</option><option value="webp">WebP（Safari 會改為 PNG）</option><option value="tiff">TIFF</option></select></Field>
          <Field label={`解析度 ${dpi} DPI`} hint="較高解析度會占用更多記憶體；iOS 建議 ≤ 200"><input type="range" min={72} max={300} step={6} value={dpi} onChange={(e) => setDpi(+e.target.value)} className="w-full" /></Field>
          {(format === 'jpg' || format === 'webp') && <Field label={`品質 ${Math.round(quality * 100)}%`}><input type="range" min={0.3} max={1} step={0.05} value={quality} onChange={(e) => setQuality(+e.target.value)} className="w-full" /></Field>}
          <Field label="頁碼範圍" hint="留空 = 全部"><input className="input" value={pages} onChange={(e) => setPages(e.target.value)} placeholder="1-3,5" /></Field>
          <div className="sm:col-span-2"><button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async (rep) => {
            const imgs = await pdfToImages(src.bytes, { format, dpi, quality, pages }, rep);
            return imgs.map((i) => ({ name: `${stripExt(src.name)}_${i.name}`, data: i.bytes, mime: i.mime }));
          }, { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '🖼️'} 轉換</button></div>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} />
    </div>
  );
}

export function ImageToPdf({ id }: { id: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [pageSize, setPageSize] = useState<'fit' | 'A4' | 'Letter'>('A4');
  const [margin, setMargin] = useState(24);
  const [orientation, setOri] = useState<'auto' | 'portrait' | 'landscape'>('auto');
  const r = useRunner(id);
  const move = (i: number, d: number) => setFiles((a) => { const b = [...a]; const [x] = b.splice(i, 1); b.splice(i + d, 0, x); return b; });
  return (
    <div className="space-y-4">
      <FileDrop accept={ACCEPT_IMAGE} multiple compact={files.length > 0} label="選擇圖片（可多張，iOS 可直接選相簿）" onFiles={(f) => setFiles((a) => [...a, ...f])} />
      {files.length > 0 && (
        <>
          <ul className="space-y-1.5">
            {files.map((f, i) => (
              <li key={i} className="card flex items-center gap-2 !p-2">
                <img src={URL.createObjectURL(f)} onLoad={(e) => URL.revokeObjectURL((e.target as HTMLImageElement).src)} alt="" className="h-10 w-10 rounded object-cover" />
                <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span><span className="hint">{formatSize(f.size)}</span>
                <button className="btn btn-sm" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="btn btn-sm" disabled={i === files.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn btn-sm" onClick={() => setFiles((a) => a.filter((_, k) => k !== i))}>✕</button>
              </li>
            ))}
          </ul>
          <div className="card grid gap-3 sm:grid-cols-3">
            <Field label="頁面大小"><select className="input" value={pageSize} onChange={(e) => setPageSize(e.target.value as any)}><option value="A4">A4</option><option value="Letter">Letter</option><option value="fit">與圖片相同</option></select></Field>
            <Field label="方向"><select className="input" value={orientation} onChange={(e) => setOri(e.target.value as any)}><option value="auto">依圖片</option><option value="portrait">直向</option><option value="landscape">橫向</option></select></Field>
            <Field label="邊界 (pt)"><input type="number" min={0} className="input" value={margin} onChange={(e) => setMargin(+e.target.value)} /></Field>
          </div>
          <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async (rep) => {
            const bufs: Uint8Array[] = [];
            for (const f of files) bufs.push(await readBytes(f));
            return [{ name: 'images.pdf', data: await imagesToPdf(bufs, { pageSize, margin, orientation }, rep) }];
          }, { bytes: files.reduce((s, f) => s + f.size, 0) })}>{r.busy ? <Spinner /> : '📷'} 建立 PDF（{files.length} 張）</button>
        </>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} />
    </div>
  );
}

function TextExport({ id, ext, mime, build, label }: { id: string; ext: string; mime: string; label: string; build: (p: Awaited<ReturnType<typeof extractText>>, name: string) => string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [pages, setPages] = useState('');
  const [preview, setPreview] = useState('');
  const r = useRunner(id);
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); setPreview(''); }} />
      {src && (
        <div className="card space-y-3">
          <Field label="頁碼範圍" hint="留空 = 全部"><input className="input" value={pages} onChange={(e) => setPages(e.target.value)} /></Field>
          <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async (rep) => {
            const p = await extractText(src.bytes, { pages }, rep);
            const out = build(p, stripExt(src.name));
            setPreview(out.slice(0, 3000));
            if (!p.some((x) => x.text.trim())) throw new Error('此 PDF 沒有可擷取的文字（可能是掃描檔），請先使用 OCR 工具。');
            return [{ name: outName(src.name, '', ext), data: enc(out), mime }];
          }, { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '▶'} {label}</button>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} />
      {preview && <pre className="card max-h-72 overflow-auto whitespace-pre-wrap text-xs">{preview}</pre>}
    </div>
  );
}
export const PdfToText = ({ id }: { id: string }) => <TextExport id={id} ext="txt" mime="text/plain" label="轉為 .txt" build={(p) => toPlainText(p)} />;
export const PdfToHtml = ({ id }: { id: string }) => <TextExport id={id} ext="html" mime="text/html" label="轉為 HTML" build={(p, n) => toHtml(p, n)} />;
export const PdfToMarkdown = ({ id }: { id: string }) => <TextExport id={id} ext="md" mime="text/markdown" label="轉為 Markdown" build={(p) => toMarkdown(p)} />;

export function TextToPdf({ id }: { id: string }) {
  const [text, setText] = useState('');
  const [size, setSize] = useState(12);
  const [pageSize, setPageSize] = useState<'A4' | 'Letter'>('A4');
  const r = useRunner(id);
  return (
    <div className="space-y-4">
      <FileDrop accept=".txt,text/plain" label="選擇 .txt 檔案（或直接在下方貼上文字）" compact onFiles={async (f) => setText(await f[0].text())} />
      <textarea className="input min-h-48 font-mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="在此貼上或輸入文字…" />
      <div className="card grid grid-cols-2 gap-3">
        <Field label="字級 (pt)"><input type="number" min={6} max={48} className="input" value={size} onChange={(e) => setSize(+e.target.value)} /></Field>
        <Field label="頁面"><select className="input" value={pageSize} onChange={(e) => setPageSize(e.target.value as any)}><option>A4</option><option>Letter</option></select></Field>
      </div>
      <button className="btn btn-primary" disabled={r.busy || !text.trim()} onClick={() => r.run(async () => [{ name: 'text.pdf',
        data: await textToPdf(text, { size, margin: 56, pageSize: PAGE_SIZES[pageSize] }, renderTextImage) }], { bytes: text.length })}>
        {r.busy ? <Spinner /> : '🔤'} 建立 PDF</button>
      <Alert kind="info">含中日文時，文字會以影像形式嵌入（無法選取）。純英文/拉丁字元則為可選取文字。</Alert>
      <RunStatus r={r} /><Outputs items={r.outputs} />
    </div>
  );
}

// ---------- PDF → Office（本機簡易版，檔案不上傳） ----------
function PdfToOffice({ id, fmt, localLabel, local }: { id: string; fmt: 'docx' | 'xlsx' | 'pptx'; localLabel: string; local: (s: PdfSource, rep: any) => Promise<Uint8Array> }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const r = useRunner(id);
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card space-y-3">
          <Alert kind="info">{localLabel}。需要精確還原版面時，建議使用桌面 Office / LibreOffice 開啟 PDF 後另存。</Alert>
          <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async (rep) => [{ name: outName(src.name, '', fmt), data: await local(src, rep) }], { bytes: src.originalSize })}>
            {r.busy ? <Spinner /> : '▶'} 轉換為 .{fmt}</button>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} />
    </div>
  );
}
export const PdfToDocx = ({ id }: { id: string }) => <PdfToOffice id={id} fmt="docx" localLabel="只輸出文字與標題層級，不含版面、表格與圖片" local={async (s, rep) => toDocx(await extractText(s.bytes, {}, rep))} />;
export const PdfToXlsx = ({ id }: { id: string }) => <PdfToOffice id={id} fmt="xlsx" localLabel="每頁一個工作表，依文字間距分欄；不是真正的表格辨識" local={async (s, rep) => toXlsx(await extractText(s.bytes, {}, rep))} />;
export const PdfToPptx = ({ id }: { id: string }) => <PdfToOffice id={id} fmt="pptx" localLabel="每頁一張全幅圖片投影片（外觀精確、文字不可編輯）" local={(s, rep) => toPptx(s.bytes, { dpi: 150 }, rep)} />;

