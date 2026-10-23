import { useState } from 'react';
import { Alert, Field, Outputs, PdfPicker, RunStatus, Spinner, outName, useRunner, usePdfDoc, type PdfSource } from '../../components/common';
import { AnnotateEditor } from '../../components/AnnotateEditor';
import { applyAnnotations, type AnnMap } from '../ops/annotate';
import { stampPages, watermark, type Anchor, type RGB, type TextStyle } from '../ops/stamp';
import { renderTextImage } from '../../lib/textImage';
import { sniffImage, readBytes } from '../../lib/files';

const hexToRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function Annotate({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const { doc, error } = usePdfDoc(src?.bytes ?? null);
  const [anns, setAnns] = useState<AnnMap>({});
  const r = useRunner(id);
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); setAnns({}); r.setOutputs([]); }} />
      {error && <Alert kind="error">{error}</Alert>}
      {src && doc && (
        <>
          <AnnotateEditor pdf={doc} pageCount={src.pages} anns={anns} onChange={setAnns} />
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async () => [{ name: outName(src.name, '_annotated'), data: await applyAnnotations(src.bytes, anns, renderTextImage) }], { bytes: src.originalSize })}>
              {r.busy ? <Spinner /> : '💾'} 套用標記並輸出
            </button>
            <span className="hint">標記會直接畫入頁面內容（扁平化）；便利貼會成為標準 PDF 註解。</span>
          </div>
        </>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

const ANCHORS: { k: Anchor; l: string }[] = [
  { k: 'tl', l: '左上' }, { k: 'tc', l: '上中' }, { k: 'tr', l: '右上' }, { k: 'ml', l: '左中' }, { k: 'mc', l: '正中' }, { k: 'mr', l: '右中' },
  { k: 'bl', l: '左下' }, { k: 'bc', l: '下中' }, { k: 'br', l: '右下' },
];
function TextStyleFields({ size, setSize, color, setColor, opacity, setOpacity, font, setFont, bold, setBold }: any) {
  return (
    <>
      <Field label={`字級 ${size} pt`}><input type="range" min={6} max={160} value={size} onChange={(e) => setSize(+e.target.value)} className="w-full" /></Field>
      <Field label="顏色"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-full rounded-lg border" /></Field>
      <Field label={`不透明度 ${Math.round(opacity * 100)}%`}><input type="range" min={0.05} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} className="w-full" /></Field>
      <Field label="字型（拉丁字元）"><select className="input" value={font} onChange={(e) => setFont(e.target.value)}><option>Helvetica</option><option>Times</option><option>Courier</option></select></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} /> 粗體</label>
    </>
  );
}

export function Stamp({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [tab, setTab] = useState<'watermark' | 'header'>('watermark');
  const [kind, setKind] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('機密 CONFIDENTIAL');
  const [imgFile, setImgFile] = useState<File | null>(null);
  const [imgScale, setImgScale] = useState(0.5);
  const [size, setSize] = useState(48), [color, setColor] = useState('#dc2626'), [opacity, setOpacity] = useState(0.25);
  const [font, setFont] = useState<'Helvetica' | 'Times' | 'Courier'>('Helvetica'), [bold, setBold] = useState(true);
  const [rotate, setRotate] = useState(45), [tile, setTile] = useState(false), [pages, setPages] = useState('');
  const [hTpl, setHTpl] = useState('{file}'), [fTpl, setFTpl] = useState('第 {page} / {pages} 頁'), [hf, setHf] = useState<'header' | 'footer' | 'both'>('both');
  const [hAnchor, setHAnchor] = useState<Anchor>('tc'), [fAnchor, setFAnchor] = useState<Anchor>('bc');
  const [hSize, setHSize] = useState(10);
  const r = useRunner(id);
  const style = (): TextStyle => ({ size, color: hexToRgb(color), opacity, font, bold });
  const run = () => r.run(async () => {
    if (!src) return;
    let out = src.bytes;
    if (tab === 'watermark') {
      let image: { bytes: Uint8Array; type: 'png' | 'jpg' } | undefined;
      if (kind === 'image') {
        if (!imgFile) throw new Error('請選擇浮水印圖片');
        const b = await readBytes(imgFile); const t = sniffImage(b);
        if (t === 'png' || t === 'jpg') image = { bytes: b, type: t };
        else { const bmp = await createImageBitmap(imgFile); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d')!.drawImage(bmp, 0, 0);
          image = { bytes: new Uint8Array(await (await new Promise<Blob>((res) => c.toBlob((x) => res(x!), 'image/png'))).arrayBuffer()), type: 'png' }; }
      }
      out = await watermark(out, { kind, text, image, imageScale: imgScale, style: style(), rotate, tile, pages }, renderTextImage);
    } else {
      const st: TextStyle = { size: hSize, color: hexToRgb(color), opacity: 1, font, bold: false };
      if (hf !== 'footer' && hTpl) out = await stampPages(out, { template: hTpl, anchor: hAnchor, margin: 24, style: st, pages, fileName: src.name }, renderTextImage);
      if (hf !== 'header' && fTpl) out = await stampPages(out, { template: fTpl, anchor: fAnchor, margin: 24, style: st, pages, fileName: src.name }, renderTextImage);
    }
    return [{ name: outName(src.name, tab === 'watermark' ? '_watermark' : '_hf'), data: out }];
  }, { bytes: src?.originalSize });
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card space-y-4">
          <div className="flex gap-2">
            <button className={`btn btn-sm ${tab === 'watermark' ? 'btn-primary' : ''}`} onClick={() => setTab('watermark')}>浮水印</button>
            <button className={`btn btn-sm ${tab === 'header' ? 'btn-primary' : ''}`} onClick={() => setTab('header')}>頁首 / 頁尾</button>
          </div>
          {tab === 'watermark' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="類型"><select className="input" value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="text">文字</option><option value="image">圖片</option></select></Field>
              {kind === 'text' ? <Field label="文字（支援中日文）"><input className="input" value={text} onChange={(e) => setText(e.target.value)} /></Field>
                : <Field label="圖片（PNG 可保留透明）"><input type="file" accept="image/*" className="input" onChange={(e) => setImgFile(e.target.files?.[0] ?? null)} /></Field>}
              {kind === 'text' ? <TextStyleFields {...{ size, setSize, color, setColor, opacity, setOpacity, font, setFont, bold, setBold }} />
                : <><Field label={`圖片寬度 ${Math.round(imgScale * 100)}% 頁寬`}><input type="range" min={0.1} max={1} step={0.05} value={imgScale} onChange={(e) => setImgScale(+e.target.value)} className="w-full" /></Field>
                  <Field label={`不透明度 ${Math.round(opacity * 100)}%`}><input type="range" min={0.05} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} className="w-full" /></Field></>}
              <Field label={`角度 ${rotate}°`}><input type="range" min={-90} max={90} value={rotate} onChange={(e) => setRotate(+e.target.value)} className="w-full" /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={tile} onChange={(e) => setTile(e.target.checked)} /> 平鋪整頁</label>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="位置"><select className="input" value={hf} onChange={(e) => setHf(e.target.value as any)}><option value="both">頁首 + 頁尾</option><option value="header">僅頁首</option><option value="footer">僅頁尾</option></select></Field>
              <Field label={`字級 ${hSize} pt`}><input type="range" min={6} max={24} value={hSize} onChange={(e) => setHSize(+e.target.value)} className="w-full" /></Field>
              {hf !== 'footer' && <Field label="頁首文字" hint="可用：{page} {pages} {date} {time} {file}"><input className="input" value={hTpl} onChange={(e) => setHTpl(e.target.value)} /></Field>}
              {hf !== 'footer' && <Field label="頁首對齊"><select className="input" value={hAnchor} onChange={(e) => setHAnchor(e.target.value as Anchor)}>{ANCHORS.filter((a) => a.k[0] === 't').map((a) => <option key={a.k} value={a.k}>{a.l}</option>)}</select></Field>}
              {hf !== 'header' && <Field label="頁尾文字"><input className="input" value={fTpl} onChange={(e) => setFTpl(e.target.value)} /></Field>}
              {hf !== 'header' && <Field label="頁尾對齊"><select className="input" value={fAnchor} onChange={(e) => setFAnchor(e.target.value as Anchor)}>{ANCHORS.filter((a) => a.k[0] === 'b').map((a) => <option key={a.k} value={a.k}>{a.l}</option>)}</select></Field>}
              <Field label="顏色"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-full rounded-lg border" /></Field>
            </div>
          )}
          <Field label="套用頁面" hint="留空 = 全部；可用 odd / even"><input className="input" value={pages} onChange={(e) => setPages(e.target.value)} /></Field>
          <button className="btn btn-primary" disabled={r.busy} onClick={() => void run()}>{r.busy ? <Spinner /> : '💧'} 套用</button>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}

export function PageNumbers({ id }: { id: string }) {
  const [src, setSrc] = useState<PdfSource | null>(null);
  const [mode, setMode] = useState<'page' | 'bates' | 'time'>('page');
  const [fmt, setFmt] = useState('{page} / {pages}');
  const [anchor, setAnchor] = useState<Anchor>('bc');
  const [size, setSize] = useState(10);
  const [color, setColor] = useState('#111827');
  const [pages, setPages] = useState('');
  const [start, setStart] = useState(1);
  const [prefix, setPrefix] = useState('ABC-'), [digits, setDigits] = useState(6), [suffix, setSuffix] = useState('');
  const [tpl, setTpl] = useState('列印時間：{datetime}');
  const r = useRunner(id);
  const template = mode === 'page' ? fmt : mode === 'bates' ? '{bates}' : tpl;
  return (
    <div className="space-y-4">
      <PdfPicker value={src} onChange={(s) => { setSrc(s); r.setOutputs([]); }} />
      {src && (
        <div className="card space-y-3">
          <div className="flex flex-wrap gap-2">
            {([['page', '頁碼'], ['bates', 'Bates 編號'], ['time', '日期 / 時間戳記']] as const).map(([k, l]) => <button key={k} className={`btn btn-sm ${mode === k ? 'btn-primary' : ''}`} onClick={() => setMode(k)}>{l}</button>)}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {mode === 'page' && <><Field label="格式" hint="{page} 當前頁、{pages} 總頁數、{n} 自訂起算"><input className="input" value={fmt} onChange={(e) => setFmt(e.target.value)} /></Field>
              <Field label="起始頁碼（用於 {n}）"><input type="number" className="input" value={start} onChange={(e) => setStart(+e.target.value)} /></Field></>}
            {mode === 'bates' && <><Field label="前綴"><input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Field>
              <Field label="位數"><input type="number" min={1} max={12} className="input" value={digits} onChange={(e) => setDigits(+e.target.value)} /></Field>
              <Field label="起始號碼"><input type="number" min={0} className="input" value={start} onChange={(e) => setStart(+e.target.value)} /></Field>
              <Field label="後綴"><input className="input" value={suffix} onChange={(e) => setSuffix(e.target.value)} /></Field></>}
            {mode === 'time' && <Field label="文字" hint="{date} {time} {datetime}"><input className="input" value={tpl} onChange={(e) => setTpl(e.target.value)} /></Field>}
            <Field label="位置"><select className="input" value={anchor} onChange={(e) => setAnchor(e.target.value as Anchor)}>{ANCHORS.map((a) => <option key={a.k} value={a.k}>{a.l}</option>)}</select></Field>
            <Field label={`字級 ${size} pt`}><input type="range" min={6} max={24} value={size} onChange={(e) => setSize(+e.target.value)} className="w-full" /></Field>
            <Field label="顏色"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-full rounded-lg border" /></Field>
            <Field label="套用頁面" hint="留空 = 全部"><input className="input" value={pages} onChange={(e) => setPages(e.target.value)} /></Field>
          </div>
          <div className="hint">預覽：{template.replace('{page}', '1').replace('{pages}', String(src.pages)).replace('{n}', String(start)).replace('{date}', new Date().toISOString().slice(0, 10)).replace('{datetime}', new Date().toLocaleString()).replace('{bates}', `${prefix}${String(start).padStart(digits, '0')}${suffix}`)}</div>
          <button className="btn btn-primary" disabled={r.busy} onClick={() => r.run(async () => [{ name: outName(src.name, mode === 'bates' ? '_bates' : mode === 'time' ? '_stamped' : '_numbered'), data: await stampPages(src.bytes, {
            template, anchor, margin: 24, pages, startNumber: mode === 'page' ? start : 0, fileName: src.name,
            bates: mode === 'bates' ? { prefix, digits, start, suffix } : undefined,
            style: { size, color: hexToRgb(color), opacity: 1, font: 'Helvetica' },
          }, renderTextImage) }], { bytes: src.originalSize })}>{r.busy ? <Spinner /> : '🔢'} 套用</button>
        </div>
      )}
      <RunStatus r={r} /><Outputs items={r.outputs} beforeSize={src?.originalSize} />
    </div>
  );
}
