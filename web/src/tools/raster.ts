import { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFNumber, PDFRef, PDFArray } from 'pdf-lib';
import { loadPdf, savePdf, parseRanges } from './ops/pdf';
import { openPdf, renderPage, canvasToBytes, makeCanvas, freeCanvas, pageTextItems, type PDFDocumentProxy, destroyPdf } from '../lib/pdfjs';
import { sniffImage } from '../lib/files';

export type Progress = (done: number, total: number, label?: string) => void;

// ---------- 壓縮 ----------
export type CompressLevel = 'lossless' | 'high' | 'medium' | 'low' | 'extreme';
export const COMPRESS_PRESETS: Record<Exclude<CompressLevel, 'lossless' | 'extreme'>, { quality: number; maxDim: number; label: string }> = {
  high: { quality: 0.82, maxDim: 2600, label: '高品質（輕度壓縮）' },
  medium: { quality: 0.65, maxDim: 1800, label: '平衡（建議）' },
  low: { quality: 0.45, maxDim: 1200, label: '最小檔案（明顯降畫質）' },
};

async function recompressJpeg(bytes: Uint8Array, quality: number, maxDim: number): Promise<{ bytes: Uint8Array; w: number; h: number } | null> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
  try {
    const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const c = makeCanvas(w, h);
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    const out = await canvasToBytes(c, 'image/jpeg', quality);
    freeCanvas(c);
    return { bytes: out, w, h };
  } finally { bmp.close?.(); }
}

/** 只重新壓縮內嵌 JPEG 影像：文字、向量與頁面結構完全不變。 */
export async function compressImages(bytes: Uint8Array, level: Exclude<CompressLevel, 'extreme'>, onProgress?: Progress): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  if (level !== 'lossless') {
    const { quality, maxDim } = COMPRESS_PRESETS[level];
    const ctx = doc.context;
    const entries = [...ctx.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream);
    let i = 0;
    for (const [ref, obj] of entries) {
      onProgress?.(++i, entries.length, '壓縮影像');
      const s = obj as PDFRawStream;
      const d = s.dict;
      if (d.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
      if (d.get(PDFName.of('Filter')) !== PDFName.of('DCTDecode')) continue;
      const cs = d.get(PDFName.of('ColorSpace'));
      if (cs !== PDFName.of('DeviceRGB') && cs !== PDFName.of('DeviceGray')) continue;
      if (d.has(PDFName.of('Decode')) || d.has(PDFName.of('ImageMask'))) continue;
      const raw = s.getContents();
      try {
        const r = await recompressJpeg(raw, quality, maxDim);
        if (!r || r.bytes.length >= raw.length * 0.92) continue;
        const nd = ctx.obj({
          Type: 'XObject', Subtype: 'Image', Width: r.w, Height: r.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode',
        }) as PDFDict;
        for (const k of ['SMask', 'Mask']) { const v = d.get(PDFName.of(k)); if (v) nd.set(PDFName.of(k), v); }
        ctx.assign(ref as PDFRef, PDFRawStream.of(nd, r.bytes));
      } catch { /* 無法解碼的影像（如 CMYK）維持原樣 */ }
    }
  }
  return savePdf(doc);
}

/** 全頁點陣化：最大壓縮，但文字將無法選取/搜尋（可再用 OCR 補回）。 */
export async function compressRasterize(bytes: Uint8Array, opt: { dpi: number; quality: number; password?: string }, onProgress?: Progress): Promise<Uint8Array> {
  const pdf = await openPdf(bytes, opt.password);
  const out = await PDFDocument.create();
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(i, pdf.numPages, '點陣化頁面');
      const page = await pdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const c = await renderPage(page, opt.dpi / 72);
      const jpg = await canvasToBytes(c, 'image/jpeg', opt.quality);
      freeCanvas(c);
      const img = await out.embedJpg(jpg);
      out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      page.cleanup();
    }
  } finally { await destroyPdf(pdf); }
  return savePdf(out);
}

// ---------- 轉成圖片 ----------
export interface ImgOut { name: string; bytes: Uint8Array; mime: string }
export async function pdfToImages(bytes: Uint8Array, opt: { format: 'png' | 'jpg' | 'webp' | 'tiff'; dpi: number; quality: number; pages?: string; password?: string }, onProgress?: Progress): Promise<ImgOut[]> {
  const pdf = await openPdf(bytes, opt.password);
  const idx = parseRanges(opt.pages ?? '', pdf.numPages);
  const out: ImgOut[] = [];
  try {
    for (let k = 0; k < idx.length; k++) {
      onProgress?.(k + 1, idx.length, '轉換頁面');
      const page = await pdf.getPage(idx[k] + 1);
      const c = await renderPage(page, opt.dpi / 72);
      const n = `page-${String(idx[k] + 1).padStart(3, '0')}`;
      if (opt.format === 'tiff') {
        const UTIF = (await import('utif')).default as any;
        const ctx = c.getContext('2d')!;
        const data = ctx.getImageData(0, 0, c.width, c.height);
        const tiff = new Uint8Array(UTIF.encodeImage(data.data.buffer, c.width, c.height));
        out.push({ name: `${n}.tif`, bytes: tiff, mime: 'image/tiff' });
      } else {
        const mime = opt.format === 'png' ? 'image/png' : opt.format === 'webp' ? 'image/webp' : 'image/jpeg';
        let b = await canvasToBytes(c, mime, opt.quality);
        // Safari 不支援 canvas 輸出 WebP，會退回 PNG：以實際檔頭判斷副檔名
        const real = sniffImage(b);
        out.push({ name: `${n}.${real === 'jpg' ? 'jpg' : real === 'webp' ? 'webp' : 'png'}`, bytes: b, mime: real === 'webp' ? 'image/webp' : real === 'jpg' ? 'image/jpeg' : 'image/png' });
      }
      freeCanvas(c);
      page.cleanup();
    }
  } finally { await destroyPdf(pdf); }
  return out;
}

// ---------- 圖片轉 PDF ----------
/** 將任何瀏覽器可解碼的圖片（含 TIFF）轉為 PNG/JPEG bytes 供 pdf-lib 嵌入。 */
async function toEmbeddable(b: Uint8Array): Promise<{ bytes: Uint8Array; type: 'png' | 'jpg' }> {
  const t = sniffImage(b);
  if (t === 'png' || t === 'jpg') return { bytes: b, type: t };
  if (t === 'tiff') {
    const UTIF = (await import('utif')).default as any;
    const ifds = UTIF.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    UTIF.decodeImage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const c = makeCanvas(ifds[0].width, ifds[0].height);
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), ifds[0].width, ifds[0].height), 0, 0);
    return { bytes: await canvasToBytes(c, 'image/png'), type: 'png' };
  }
  const bmp = await createImageBitmap(new Blob([b as BlobPart]));
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { bytes: await canvasToBytes(c, 'image/png'), type: 'png' };
}
export interface ImagesToPdfOpts { pageSize: 'fit' | 'A4' | 'Letter'; margin: number; orientation: 'auto' | 'portrait' | 'landscape' }
export async function imagesToPdf(images: Uint8Array[], opt: ImagesToPdfOpts, onProgress?: Progress): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (let i = 0; i < images.length; i++) {
    onProgress?.(i + 1, images.length, '嵌入圖片');
    const e = await toEmbeddable(images[i]);
    const img = e.type === 'png' ? await out.embedPng(e.bytes) : await out.embedJpg(e.bytes);
    let W = img.width, H = img.height, m = 0;
    if (opt.pageSize !== 'fit') {
      [W, H] = opt.pageSize === 'A4' ? [595.28, 841.89] : [612, 792];
      const land = opt.orientation === 'auto' ? img.width > img.height : opt.orientation === 'landscape';
      if (land) [W, H] = [H, W];
      m = opt.margin;
    } else m = 0;
    const page = out.addPage([W, H]);
    const k = Math.min((W - 2 * m) / img.width, (H - 2 * m) / img.height, opt.pageSize === 'fit' ? 1 : Infinity);
    const w = img.width * k, h = img.height * k;
    page.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  }
  return savePdf(out);
}

// ---------- 真正的塗黑 ----------
export interface RedactRect { x: number; y: number; w: number; h: number } // 視覺座標，左上原點，pt
export interface RedactOpts { dpi: number; quality: number; password?: string }
/**
 * 把含塗黑區域的頁面「重新點陣化」並以全新頁面取代：
 *  底層文字、向量、影像、註解、表單欄位都不會存在於輸出檔，無法被選取或還原。
 *  整份文件同時以全新檔案重建，Info/XMP/書籤/附件等文件層級資料都不會被帶入。
 */
export async function redactPdf(bytes: Uint8Array, rects: Record<number, RedactRect[]>, opt: RedactOpts, onProgress?: Progress): Promise<Uint8Array> {
  const pdf = await openPdf(bytes, opt.password);
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }).catch(() => null);
  const out = await PDFDocument.create();
  try {
    const total = pdf.numPages;
    for (let i = 0; i < total; i++) {
      onProgress?.(i + 1, total, '處理頁面');
      const rs = rects[i];
      if (!rs?.length) {
        if (src) { const [p] = await out.copyPages(src, [i]); out.addPage(p); continue; }
      }
      const page = await pdf.getPage(i + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = opt.dpi / 72;
      const c = await renderPage(page, scale);
      const k = c.width / vp1.width; // 實際縮放（可能因 canvas 上限而降低）
      if (rs?.length) {
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#000';
        for (const r of rs) ctx.fillRect(Math.floor(r.x * k) - 1, Math.floor(r.y * k) - 1, Math.ceil(r.w * k) + 2, Math.ceil(r.h * k) + 2);
      }
      const jpg = await canvasToBytes(c, 'image/jpeg', opt.quality);
      freeCanvas(c);
      const img = await out.embedJpg(jpg);
      out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      page.cleanup();
    }
  } finally { await destroyPdf(pdf); }
  return savePdf(out);
}

/** 依文字/正規表達式找出需塗黑的矩形（近似：以字元比例切分文字項目的寬度）。 */
export async function findTextRects(pdf: PDFDocumentProxy, patterns: RegExp[], pageIdx?: number[]): Promise<Record<number, RedactRect[]>> {
  const out: Record<number, RedactRect[]> = {};
  const pages = pageIdx ?? Array.from({ length: pdf.numPages }, (_, i) => i);
  for (const i of pages) {
    const page = await pdf.getPage(i + 1);
    for (const it of await pageTextItems(page)) {
      for (const re of patterns) {
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        let m: RegExpExecArray | null;
        while ((m = g.exec(it.str))) {
          if (!m[0]) { g.lastIndex++; continue; }
          const L = it.str.length;
          (out[i] ??= []).push({ x: it.x + (m.index / L) * it.w, y: it.y, w: (m[0].length / L) * it.w, h: it.h * 1.1 });
        }
      }
    }
    page.cleanup();
  }
  return out;
}

// ---------- 比較 ----------
export interface PageDiff { page: number; changedRatio: number; overlay?: HTMLCanvasElement; sizeMismatch: boolean }
export async function comparePages(a: Uint8Array, b: Uint8Array, onProgress?: Progress, pwA?: string, pwB?: string): Promise<PageDiff[]> {
  const [pa, pb] = [await openPdf(a, pwA), await openPdf(b, pwB)];
  const n = Math.max(pa.numPages, pb.numPages);
  const res: PageDiff[] = [];
  try {
    for (let i = 1; i <= n; i++) {
      onProgress?.(i, n, '比對頁面');
      if (i > pa.numPages || i > pb.numPages) { res.push({ page: i, changedRatio: 1, sizeMismatch: true }); continue; }
      const [A, B] = [await pa.getPage(i), await pb.getPage(i)];
      const ca = await renderPage(A, 1.2), cb = await renderPage(B, 1.2);
      const w = Math.min(ca.width, cb.width), h = Math.min(ca.height, cb.height);
      const da = ca.getContext('2d')!.getImageData(0, 0, w, h).data, db = cb.getContext('2d')!.getImageData(0, 0, w, h).data;
      const ov = makeCanvas(w, h), octx = ov.getContext('2d')!;
      const img = octx.createImageData(w, h);
      let changed = 0;
      for (let p = 0; p < da.length; p += 4) {
        const d = Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) + Math.abs(da[p + 2] - db[p + 2]);
        if (d > 60) { changed++; img.data[p] = 239; img.data[p + 1] = 68; img.data[p + 2] = 68; img.data[p + 3] = 255; }
        else { const g = (db[p] + db[p + 1] + db[p + 2]) / 3; const f = 255 - (255 - g) * 0.35; img.data[p] = img.data[p + 1] = img.data[p + 2] = f; img.data[p + 3] = 255; }
      }
      octx.putImageData(img, 0, 0);
      res.push({ page: i, changedRatio: changed / (w * h), overlay: ov, sizeMismatch: ca.width !== cb.width || ca.height !== cb.height });
      freeCanvas(ca); freeCanvas(cb);
      A.cleanup(); B.cleanup();
    }
  } finally { await destroyPdf(pa); await destroyPdf(pb); }
  return res;
}
