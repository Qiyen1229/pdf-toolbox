import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export type { PDFDocumentProxy, PDFPageProxy };

export class PasswordNeeded extends Error {
  constructor(public wrong: boolean) { super(wrong ? '密碼不正確' : '此檔案需要密碼'); this.name = 'PasswordNeeded'; }
}

/** 開啟 PDF（在 pdf.js Worker 內解析）。bytes 會被複製，呼叫端的資料不會被 transfer 掉。 */
export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    data: bytes.slice(0), password,
    cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/',
  });
  try { return await task.promise; }
  catch (e: any) {
    if (e?.name === 'PasswordException') throw new PasswordNeeded(e.code === 2);
    throw e;
  }
}

export const destroyPdf = (pdf: PDFDocumentProxy) => pdf.loadingTask.destroy();

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(w)); c.height = Math.max(1, Math.floor(h));
  return c;
}

/** 限制單張 canvas 的像素數（iOS Safari 約 16.7M 像素上限）。 */
export const MAX_CANVAS_PIXELS = 16_000_000;
export function safeScale(page: PDFPageProxy, wanted: number) {
  const v = page.getViewport({ scale: 1 });
  const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / (v.width * v.height));
  return Math.min(wanted, maxScale);
}

export async function renderPage(page: PDFPageProxy, scale: number, canvas?: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const s = safeScale(page, scale);
  const vp = page.getViewport({ scale: s });
  const c = canvas ?? makeCanvas(vp.width, vp.height);
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  // pdf.js 需要 canvas 位於文件內才會穩定完成繪製：離屏繪製時暫時掛載到隱藏容器
  const attached = !canvas && !c.isConnected;
  if (attached) { Object.assign(c.style, { position: 'fixed', left: '-99999px', top: '0', visibility: 'hidden' }); document.body.appendChild(c); }
  try { await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise; }
  finally { if (attached) c.remove(); }
  return c;
}

export const canvasToBlob = (c: HTMLCanvasElement, type = 'image/png', q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Canvas 輸出失敗（可能是記憶體不足）'))), type, q));
export async function canvasToBytes(c: HTMLCanvasElement, type = 'image/png', q?: number) {
  return new Uint8Array(await (await canvasToBlob(c, type, q)).arrayBuffer());
}
/** 釋放 canvas 佔用的記憶體（iOS 對 canvas 總量有限制）。 */
export function freeCanvas(c: HTMLCanvasElement) { c.width = 0; c.height = 0; }

/** 2D 仿射矩陣相乘（與 pdf.js Util.transform 相同：m1 · m2）。 */
const mul = (m1: number[], m2: number[]) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

export interface TextItem { str: string; x: number; y: number; w: number; h: number }
/** 取得頁面文字項目（座標為視覺座標，左上原點，pt）。 */
export async function pageTextItems(page: PDFPageProxy): Promise<TextItem[]> {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const out: TextItem[] = [];
  for (const it of tc.items as any[]) {
    if (!('str' in it) || !it.str) continue;
    const t = mul(vp.transform as number[], it.transform as number[]);
    const h = Math.hypot(t[2], t[3]);
    out.push({ str: it.str, x: t[4], y: t[5] - h, w: it.width * vp.scale, h });
  }
  return out;
}
