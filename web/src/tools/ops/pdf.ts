import {
  PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString, PDFNumber, PDFRef, PDFRawStream,
  StandardFonts, degrees, rgb, PDFPage, PDFFont, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
} from 'pdf-lib';

export const LOAD_OPTS = { ignoreEncryption: false, updateMetadata: false } as const;
export const loadPdf = (b: Uint8Array | ArrayBuffer, opts: Parameters<typeof PDFDocument.load>[1] = {}) =>
  PDFDocument.load(b, { ...LOAD_OPTS, ...opts });
export const savePdf = (d: PDFDocument, opts?: Parameters<PDFDocument['save']>[0]) =>
  d.save({ useObjectStreams: true, addDefaultPage: false, ...opts });

// ---------- 頁碼範圍 ----------
/** "1-3, 5, 8-" → 0-based 索引陣列（保持輸入順序，可重複）。"odd"/"even"/"all"/"last" 亦可。 */
export function parseRanges(input: string, total: number): number[] {
  const s = input.trim().toLowerCase();
  if (!s || s === 'all') return Array.from({ length: total }, (_, i) => i);
  const out: number[] = [];
  const num = (t: string) => (t === 'last' ? total : Number(t));
  for (const partRaw of s.split(/[,，;\s]+/).filter(Boolean)) {
    if (partRaw === 'odd') { for (let i = 0; i < total; i += 2) out.push(i); continue; }
    if (partRaw === 'even') { for (let i = 1; i < total; i += 2) out.push(i); continue; }
    const m = partRaw.match(/^(\d+|last)?(?:-(\d+|last)?)?$/);
    if (!m || (m[1] === undefined && m[2] === undefined)) throw new Error(`無法解析頁碼範圍：「${partRaw}」`);
    const isRange = partRaw.includes('-');
    const a = m[1] !== undefined ? num(m[1]) : 1;
    const b = isRange ? (m[2] !== undefined ? num(m[2]) : total) : a;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a > total || b > total)
      throw new Error(`頁碼超出範圍（此文件共 ${total} 頁）：「${partRaw}」`);
    if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1);
    else for (let i = a; i >= b; i--) out.push(i - 1);
  }
  if (!out.length) throw new Error('沒有選取任何頁面');
  return out;
}

// ---------- 合併 / 分割 / 擷取 ----------
export interface MergeInput { bytes: Uint8Array; pages?: string }
export async function mergePdfs(inputs: MergeInput[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const inp of inputs) {
    const src = await loadPdf(inp.bytes);
    const idx = parseRanges(inp.pages ?? '', src.getPageCount());
    const pages = await out.copyPages(src, idx);
    pages.forEach((p) => out.addPage(p));
  }
  return savePdf(out);
}

export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const src = await loadPdf(bytes);
  const out = await PDFDocument.create();
  (await out.copyPages(src, indices)).forEach((p) => out.addPage(p));
  return savePdf(out);
}

export type SplitMode = { mode: 'ranges'; ranges: string } | { mode: 'every'; n: number } | { mode: 'single' };
/** 回傳多個輸出檔（name 不含副檔名）。ranges 模式下以「;」分隔多組，每組輸出一個檔。 */
export async function splitPdf(bytes: Uint8Array, opt: SplitMode): Promise<{ name: string; bytes: Uint8Array }[]> {
  const src = await loadPdf(bytes);
  const total = src.getPageCount();
  const groups: number[][] = [];
  if (opt.mode === 'single') for (let i = 0; i < total; i++) groups.push([i]);
  else if (opt.mode === 'every') {
    if (!(opt.n >= 1)) throw new Error('每份頁數必須 ≥ 1');
    for (let i = 0; i < total; i += opt.n) groups.push(Array.from({ length: Math.min(opt.n, total - i) }, (_, k) => i + k));
  } else for (const g of opt.ranges.split(/[;；\n]+/).filter((x) => x.trim())) groups.push(parseRanges(g, total));
  if (!groups.length) throw new Error('沒有可輸出的頁面');
  const res: { name: string; bytes: Uint8Array }[] = [];
  for (const g of groups) {
    const out = await PDFDocument.create();
    (await out.copyPages(src, g)).forEach((p) => out.addPage(p));
    const label = g.length === 1 ? `p${g[0] + 1}` : `p${g[0] + 1}-${g[g.length - 1] + 1}`;
    res.push({ name: label, bytes: await savePdf(out) });
  }
  return res;
}

// ---------- 頁面整理 ----------
export interface PageSpec { src: number; rotate?: number; blank?: { w: number; h: number } }
/** 依規格重建文件：可重排、旋轉、刪除（不列入）、複製（重複列入）、插入空白頁。 */
export async function rebuildPages(bytes: Uint8Array, specs: PageSpec[]): Promise<Uint8Array> {
  if (!specs.length) throw new Error('至少需要保留一頁');
  const src = await loadPdf(bytes);
  const out = await PDFDocument.create();
  for (const s of specs) {
    if (s.blank) { out.addPage([s.blank.w, s.blank.h]); continue; }
    const [p] = await out.copyPages(src, [s.src]);
    if (s.rotate) p.setRotation(degrees(((p.getRotation().angle + s.rotate) % 360 + 360) % 360));
    out.addPage(p);
  }
  return savePdf(out);
}

export async function rotatePdf(bytes: Uint8Array, angle: number, pages = ''): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const idx = new Set(parseRanges(pages, d.getPageCount()));
  d.getPages().forEach((p, i) => { if (idx.has(i)) p.setRotation(degrees(((p.getRotation().angle + angle) % 360 + 360) % 360)); });
  return savePdf(d);
}

// ---------- 版面：裁切 / 調整大小 ----------
export interface CropMargins { top: number; right: number; bottom: number; left: number } // 單位 pt
export async function cropMargins(bytes: Uint8Array, m: CropMargins, pages = ''): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const idx = new Set(parseRanges(pages, d.getPageCount()));
  d.getPages().forEach((p, i) => {
    if (!idx.has(i)) return;
    const mb = p.getMediaBox();
    const w = mb.width - m.left - m.right, h = mb.height - m.top - m.bottom;
    if (w < 20 || h < 20) throw new Error(`第 ${i + 1} 頁裁切後過小`);
    p.setCropBox(mb.x + m.left, mb.y + m.bottom, w, h);
  });
  return savePdf(d);
}
/** 對單頁以「視覺座標」(左上原點，pt) 裁切到指定矩形。 */
export async function cropRect(bytes: Uint8Array, rects: Record<number, { x: number; y: number; w: number; h: number }>): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  d.getPages().forEach((p, i) => {
    const r = rects[i]; if (!r) return;
    const f = visibleFrame(p);
    const a = toUser(p, r.x, f.h - (r.y + r.h), 0);
    const b = toUser(p, r.x + r.w, f.h - r.y, 0);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    p.setCropBox(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  });
  return savePdf(d);
}

export const PAGE_SIZES: Record<string, [number, number]> = {
  A3: [841.89, 1190.55], A4: [595.28, 841.89], A5: [419.53, 595.28], Letter: [612, 792], Legal: [612, 1008], B5: [498.9, 708.66],
};
export async function resizePages(bytes: Uint8Array, opt: { size: [number, number]; orientation: 'auto' | 'portrait' | 'landscape'; fit: 'contain' | 'cover' | 'stretch' }): Promise<Uint8Array> {
  const src = await loadPdf(bytes);
  const out = await PDFDocument.create();
  const srcPages = src.getPages();
  const embedded = await out.embedPages(srcPages, srcPages.map((p) => {
    const b = p.getCropBox();
    return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
  }));
  srcPages.forEach((sp, i) => {
    const f = visibleFrame(sp);
    let [W, H] = opt.size;
    const landscape = opt.orientation === 'auto' ? f.w > f.h : opt.orientation === 'landscape';
    if (landscape !== W > H) [W, H] = [H, W];
    const np = out.addPage([W, H]);
    let sx = W / f.w, sy = H / f.h;
    if (opt.fit === 'contain') sx = sy = Math.min(sx, sy);
    else if (opt.fit === 'cover') sx = sy = Math.max(sx, sy);
    const w = f.w * sx, h = f.h * sy; // 視覺尺寸
    const ux = (W - w) / 2, uy = (H - h) / 2;
    const e = embedded[i], rot = f.rot;
    if (rot === 0) np.drawPage(e, { x: ux, y: uy, width: w, height: h });
    else {
      const width = rot === 180 ? w : h, height = rot === 180 ? h : w; // 使用者空間尺寸映射
      const pos = rot === 90 ? { x: ux, y: uy + h } : rot === 180 ? { x: ux + w, y: uy + h } : { x: ux + w, y: uy };
      np.drawPage(e, { ...pos, width, height, rotate: degrees(-rot) });
    }
  });
  return savePdf(out);
}

// ---------- 座標：視覺座標 ↔ 使用者空間 ----------
export function visibleFrame(p: PDFPage) {
  const b = p.getCropBox?.() ?? p.getMediaBox();
  const rot = ((p.getRotation().angle % 360) + 360) % 360;
  const rw = b.width, rh = b.height;
  return { w: rot % 180 === 0 ? rw : rh, h: rot % 180 === 0 ? rh : rw, rot, rw, rh, ox: b.x, oy: b.y };
}
/** 視覺座標（原點左下、含旋轉）→ 使用者空間座標；angle 為視覺逆時針角度，回傳使用者空間角度。 */
export function toUser(p: PDFPage, vx: number, vy: number, vAngle = 0) {
  const f = visibleFrame(p);
  let x = vx, y = vy;
  if (f.rot === 90) { x = f.rw - vy; y = vx; }
  else if (f.rot === 180) { x = f.rw - vx; y = f.rh - vy; }
  else if (f.rot === 270) { x = vy; y = f.rh - vx; }
  return { x: x + f.ox, y: y + f.oy, angle: vAngle + f.rot };
}

// ---------- 修復 ----------
export async function repairPdf(bytes: Uint8Array): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const notes: string[] = [];
  try {
    const d = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
    // 以複製頁面的方式重建結構，丟棄損毀的物件與孤立資源
    const out = await PDFDocument.create();
    const pages = await out.copyPages(d, d.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    notes.push(`成功讀取 ${d.getPageCount()} 頁並重建檔案結構`);
    return { bytes: await savePdf(out), notes };
  } catch (e: any) {
    // 最後手段：掃描 %PDF 標頭與 xref 以外的內容，嘗試重新載入
    try {
      const d = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false, parseSpeed: 100 as any });
      notes.push('已以寬鬆模式載入並重新輸出');
      return { bytes: await savePdf(d), notes };
    } catch (e2: any) {
      throw new Error('無法修復：檔案結構損毀過於嚴重（' + (e2?.message || e?.message) + '）。');
    }
  }
}

// ---------- 中繼資料 ----------
export interface MetaFields { title?: string; author?: string; subject?: string; keywords?: string; creator?: string; producer?: string }
export async function readMetadata(bytes: Uint8Array): Promise<MetaFields & { created?: Date; modified?: Date }> {
  const d = await loadPdf(bytes);
  return {
    title: d.getTitle(), author: d.getAuthor(), subject: d.getSubject(), keywords: d.getKeywords(),
    creator: d.getCreator(), producer: d.getProducer(), created: d.getCreationDate(), modified: d.getModificationDate(),
  };
}
/** 從 JPEG 位元組移除 EXIF/XMP(APP1)、IPTC(APP13) 等中繼資料段（GPS、裝置型號都在其中）。 */
export function stripJpegMetadata(b: Uint8Array): { bytes: Uint8Array; removed: number } {
  if (b[0] !== 0xff || b[1] !== 0xd8) return { bytes: b, removed: 0 };
  let i = 2, removed = 0;
  const keep: [number, number][] = [[0, 2]];
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) break; // SOS / EOI：之後是影像資料
    if (m === 0xff) { i++; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    // 保留 JFIF(E0)、ICC(E2)、Adobe(EE)；移除 EXIF/XMP(E1)、IPTC(ED)、註解(FE) 與其他 APPn
    if (m === 0xe1 || m === 0xfe || (m >= 0xe3 && m <= 0xef && m !== 0xee)) { removed += len + 2; }
    else keep.push([i, i + 2 + len]);
    i += 2 + len;
  }
  keep.push([i, b.length]);
  if (!removed) return { bytes: b, removed: 0 };
  const total = keep.reduce((s2, [a, c]) => s2 + (c - a), 0);
  const res = new Uint8Array(total);
  let o = 0;
  for (const [a, c] of keep) { res.set(b.subarray(a, c), o); o += c - a; }
  return { bytes: res, removed };
}

/** 徹底移除：Info 字典、XMP Metadata 串流、頁面層級 PieceInfo、自訂屬性。 */
export async function stripMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  d.setTitle(''); d.setAuthor(''); d.setSubject(''); d.setKeywords([]); d.setCreator(''); d.setProducer('');
  const ctx = d.context;
  // 不只移除參照，也要把間接物件本身從檔案中刪除，否則舊內容仍會殘留在輸出位元組裡
  const kill = (dict: PDFDict, key: string) => {
    const v = dict.get(PDFName.of(key));
    if (v instanceof PDFRef) ctx.delete(v);
    dict.delete(PDFName.of(key));
  };
  const info = (ctx.trailerInfo as any).Info;
  if (info instanceof PDFRef) ctx.delete(info);
  (ctx.trailerInfo as any).Info = undefined;
  kill(d.catalog, 'Metadata'); kill(d.catalog, 'PieceInfo');
  for (const p of d.getPages()) { kill(p.node, 'Metadata'); kill(p.node, 'PieceInfo'); }
  // 內嵌 JPEG 影像的 EXIF / GPS / 裝置資訊
  for (const [ref, obj] of [...ctx.enumerateIndirectObjects()]) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dct = obj.dict.get(PDFName.of('Filter')) === PDFName.of('DCTDecode');
    if (!dct) continue;
    const r = stripJpegMetadata(obj.getContents());
    if (r.removed) {
      const nd = obj.dict.clone(ctx) as PDFDict;
      nd.set(PDFName.of('Length'), PDFNumber.of(r.bytes.length));
      ctx.assign(ref as PDFRef, PDFRawStream.of(nd, r.bytes));
    }
  }
  return savePdf(d);
}
export async function writeMetadata(bytes: Uint8Array, m: MetaFields): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  if (m.title !== undefined) d.setTitle(m.title);
  if (m.author !== undefined) d.setAuthor(m.author);
  if (m.subject !== undefined) d.setSubject(m.subject);
  if (m.keywords !== undefined) d.setKeywords(m.keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
  if (m.creator !== undefined) d.setCreator(m.creator);
  if (m.producer !== undefined) d.setProducer(m.producer);
  return savePdf(d);
}
