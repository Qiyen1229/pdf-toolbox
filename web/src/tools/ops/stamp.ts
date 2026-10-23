import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { loadPdf, savePdf, parseRanges, visibleFrame, toUser } from './pdf';

export type RGB = [number, number, number]; // 0–255
export type Anchor = 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br';
/** 把任意文字轉成 PNG（供 CJK 等標準字型無法顯示的字元使用）。瀏覽器端由 canvas 實作。 */
export type TextImageRenderer = (text: string, px: number, color: RGB, family?: string, bold?: boolean) => Promise<{ png: Uint8Array; width: number; height: number }>;

const LATIN = /^[ -~ -ÿ]*$/;
const col = (c: RGB) => rgb(c[0] / 255, c[1] / 255, c[2] / 255);

export interface TextStyle { size: number; color: RGB; opacity: number; font: 'Helvetica' | 'Times' | 'Courier'; bold?: boolean }

const FONT_MAP = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold],
} as const;

export class TextDrawer {
  private fonts = new Map<string, PDFFont>();
  private imgs = new Map<string, PDFImage>();
  constructor(private doc: PDFDocument, private render?: TextImageRenderer) {}

  private async font(f: TextStyle['font'], bold?: boolean) {
    const name = FONT_MAP[f][bold ? 1 : 0];
    let ft = this.fonts.get(name);
    if (!ft) { ft = await this.doc.embedFont(name); this.fonts.set(name, ft); }
    return ft;
  }
  /** 回傳尺寸與繪製函式；視覺中心 (cx, cy) 為左下原點的視覺座標。 */
  async measure(text: string, st: TextStyle) {
    if (LATIN.test(text)) {
      const ft = await this.font(st.font, st.bold);
      return { w: ft.widthOfTextAtSize(text, st.size), h: st.size, ft, img: undefined as PDFImage | undefined };
    }
    if (!this.render) throw new Error('此文字包含非拉丁字元，需要瀏覽器的 Canvas 才能輸出');
    const key = `${text}|${st.size}|${st.color}|${st.bold}`;
    let img = this.imgs.get(key);
    const r = await this.render(text, st.size * 3, st.color, undefined, st.bold);
    if (!img) { img = await this.doc.embedPng(r.png); this.imgs.set(key, img); }
    return { w: r.width / 3, h: r.height / 3, ft: undefined as PDFFont | undefined, img };
  }
  async drawCentered(page: PDFPage, text: string, st: TextStyle, cx: number, cy: number, vAngle: number) {
    const m = await this.measure(text, st);
    const a = (vAngle * Math.PI) / 180;
    const hw = m.w / 2, hh = m.h / 2 - (m.ft ? st.size * 0.2 : 0);
    // 文字左下角（視覺座標）
    const ox = cx - (hw * Math.cos(a) - hh * Math.sin(a));
    const oy = cy - (hw * Math.sin(a) + hh * Math.cos(a));
    const u = toUser(page, ox, oy, vAngle);
    if (m.ft) page.drawText(text, { x: u.x, y: u.y, size: st.size, font: m.ft, color: col(st.color), opacity: st.opacity, rotate: degrees(u.angle) });
    else page.drawImage(m.img!, { x: u.x, y: u.y, width: m.w, height: m.h, opacity: st.opacity, rotate: degrees(u.angle) });
    return m;
  }
}

function anchorPoint(a: Anchor, W: number, H: number, w: number, h: number, margin: number) {
  const x = a[1] === 'l' ? margin + w / 2 : a[1] === 'r' ? W - margin - w / 2 : W / 2;
  const y = a[0] === 't' ? H - margin - h / 2 : a[0] === 'b' ? margin + h / 2 : H / 2;
  return { x, y };
}

export interface StampOpts {
  template: string;
  pages?: string;
  anchor: Anchor;
  margin: number;
  style: TextStyle;
  rotate?: number;
  /** {n} 的起始值（頁碼起算）。 */
  startNumber?: number;
  fileName?: string;
  /** Bates：{bates} 展開為 prefix + 補零序號 + suffix */
  bates?: { prefix: string; digits: number; start: number; suffix: string };
  now?: Date;
}
const pad = (n: number, d = 2) => String(n).padStart(d, '0');
export function expandTemplate(t: string, o: { page: number; pages: number; seq: number; startNumber: number; fileName?: string; bates?: StampOpts['bates']; now: Date }) {
  const d = o.now;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return t
    .replace(/\{page\}/g, String(o.page))
    .replace(/\{pages\}/g, String(o.pages))
    .replace(/\{n\}/g, String(o.seq + o.startNumber))
    .replace(/\{date\}/g, date).replace(/\{time\}/g, time).replace(/\{datetime\}/g, `${date} ${time}`)
    .replace(/\{file\}/g, o.fileName ?? '')
    .replace(/\{bates\}/g, o.bates ? `${o.bates.prefix}${pad(o.bates.start + o.seq, o.bates.digits)}${o.bates.suffix}` : '');
}

/** 頁首/頁尾/頁碼/Bates/時間戳記：全部用同一個模板引擎。 */
export async function stampPages(bytes: Uint8Array, opts: StampOpts, render?: TextImageRenderer): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const total = doc.getPageCount();
  const idx = parseRanges(opts.pages ?? '', total);
  const td = new TextDrawer(doc, render);
  const pages = doc.getPages();
  const now = opts.now ?? new Date();
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], p = pages[i];
    const text = expandTemplate(opts.template, { page: i + 1, pages: total, seq: k, startNumber: opts.startNumber ?? 0, fileName: opts.fileName, bates: opts.bates, now });
    if (!text) continue;
    const m = await td.measure(text, opts.style);
    const f = visibleFrame(p);
    const pt = anchorPoint(opts.anchor, f.w, f.h, m.w, m.h, opts.margin);
    await td.drawCentered(p, text, opts.style, pt.x, pt.y, opts.rotate ?? 0);
  }
  return savePdf(doc);
}

export interface WatermarkOpts {
  kind: 'text' | 'image';
  text?: string;
  image?: { bytes: Uint8Array; type: 'png' | 'jpg' };
  imageScale?: number; // 相對頁寬 0–1
  style: TextStyle;
  rotate: number;
  tile: boolean;
  pages?: string;
  /** 浮水印位於內容之上（true）或之下（false，僅在內容不透明時會被蓋住） */
  over?: boolean;
}
export async function watermark(bytes: Uint8Array, o: WatermarkOpts, render?: TextImageRenderer): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const idx = new Set(parseRanges(o.pages ?? '', doc.getPageCount()));
  const td = new TextDrawer(doc, render);
  let img: PDFImage | undefined;
  if (o.kind === 'image') {
    if (!o.image) throw new Error('請選擇浮水印圖片');
    img = o.image.type === 'png' ? await doc.embedPng(o.image.bytes) : await doc.embedJpg(o.image.bytes);
  } else if (!o.text?.trim()) throw new Error('請輸入浮水印文字');
  for (const [i, p] of doc.getPages().entries()) {
    if (!idx.has(i)) continue;
    const f = visibleFrame(p);
    let w: number, h: number;
    if (img) { w = f.w * (o.imageScale ?? 0.5); h = (img.height / img.width) * w; }
    else { const m = await td.measure(o.text!, o.style); w = m.w; h = m.h; }
    const points: { x: number; y: number }[] = [];
    if (o.tile) {
      const gx = w * 1.6 + 30, gy = h * 3 + 40;
      for (let y = gy / 2; y < f.h + gy; y += gy) for (let x = gx / 2; x < f.w + gx; x += gx) points.push({ x: x - ((Math.round(y / gy) % 2) * gx) / 2, y });
    } else points.push({ x: f.w / 2, y: f.h / 2 });
    for (const pt of points) {
      if (img) {
        const a = (o.rotate * Math.PI) / 180;
        const ox = pt.x - (w / 2) * Math.cos(a) + (h / 2) * Math.sin(a), oy = pt.y - (w / 2) * Math.sin(a) - (h / 2) * Math.cos(a);
        const u = toUser(p, ox, oy, o.rotate);
        p.drawImage(img, { x: u.x, y: u.y, width: w, height: h, opacity: o.style.opacity, rotate: degrees(u.angle) });
      } else await td.drawCentered(p, o.text!, o.style, pt.x, pt.y, o.rotate);
    }
  }
  return savePdf(doc);
}
