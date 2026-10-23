import { createWorker, type Worker } from 'tesseract.js';
import { PDFDocument } from 'pdf-lib';
import { openPdf, renderPage, canvasToBytes, freeCanvas, makeCanvas, destroyPdf } from '../lib/pdfjs';
import { parseRanges, savePdf } from './ops/pdf';
import { sniffImage } from '../lib/files';
import type { Progress } from './raster';

export const OCR_LANGS = [
  { id: 'chi_tra', label: '繁體中文' }, { id: 'chi_sim', label: '简体中文' }, { id: 'eng', label: 'English' }, { id: 'jpn', label: '日本語' },
] as const;

async function makeWorker(langs: string[], onLog?: (p: number, status: string) => void): Promise<Worker> {
  return createWorker(langs, 1, {
    workerPath: '/vendor/tesseract/worker.min.js',
    corePath: '/vendor/tesseract/core',
    langPath: '/vendor/tessdata',
    gzip: true,
    cacheMethod: 'none',
    logger: (m) => onLog?.(m.progress ?? 0, m.status),
  });
}

/** 對 PDF 每頁做 OCR，輸出「可搜尋 PDF」（頁面影像 + 隱形文字層）。 */
export async function ocrPdf(bytes: Uint8Array, opt: { langs: string[]; dpi: number; pages?: string; password?: string }, onProgress?: Progress): Promise<{ pdf: Uint8Array; text: string }> {
  const pdf = await openPdf(bytes, opt.password);
  const idx = parseRanges(opt.pages ?? '', pdf.numPages);
  const worker = await makeWorker(opt.langs);
  const out = await PDFDocument.create();
  const texts: string[] = [];
  try {
    for (let k = 0; k < idx.length; k++) {
      onProgress?.(k + 1, idx.length, `OCR 第 ${idx[k] + 1} 頁`);
      const page = await pdf.getPage(idx[k] + 1);
      const c = await renderPage(page, opt.dpi / 72);
      const jpg = await canvasToBytes(c, 'image/jpeg', 0.88);
      freeCanvas(c);
      const r = await worker.recognize(new Blob([jpg as BlobPart], { type: 'image/jpeg' }), {}, { pdf: true, text: true });
      texts.push(r.data.text);
      if (r.data.pdf) {
        const one = await PDFDocument.load(new Uint8Array(r.data.pdf));
        const [p] = await out.copyPages(one, [0]);
        // 保持與原頁相同的版面大小（tesseract 以像素為單位輸出）
        const vp = page.getViewport({ scale: 1 });
        const { width, height } = p.getSize();
        p.scaleContent(vp.width / width, vp.height / height);
        p.setSize(vp.width, vp.height);
        out.addPage(p);
      }
      page.cleanup();
    }
  } finally { await worker.terminate(); await destroyPdf(pdf); }
  return { pdf: await savePdf(out), text: texts.join('\n\n') };
}

export async function ocrImage(bytes: Uint8Array, langs: string[]): Promise<string> {
  const worker = await makeWorker(langs);
  try {
    const t = sniffImage(bytes);
    const r = await worker.recognize(new Blob([bytes as BlobPart], { type: t ? `image/${t === 'jpg' ? 'jpeg' : t}` : 'image/png' }));
    return r.data.text;
  } finally { await worker.terminate(); }
}
