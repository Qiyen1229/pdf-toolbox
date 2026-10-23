import { BlendMode, LineCapStyle, PDFDocument, PDFHexString, PDFName, degrees, rgb } from 'pdf-lib';
import { loadPdf, savePdf, toUser, visibleFrame } from './pdf';
import { TextDrawer, type RGB, type TextImageRenderer } from './stamp';

/** 所有座標為「視覺座標」：左上原點、單位 pt（與畫面上看到的頁面一致，已含頁面旋轉）。 */
export type Ann = { id: string; color: RGB } & (
  | { t: 'highlight' | 'underline' | 'strike' | 'squiggly'; x: number; y: number; w: number; h: number }
  | { t: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; fill: boolean; width: number }
  | { t: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; width: number }
  | { t: 'ink'; pts: [number, number][]; width: number }
  | { t: 'text'; x: number; y: number; w: number; text: string; size: number; bold?: boolean }
  | { t: 'note'; x: number; y: number; text: string }
  | { t: 'image'; x: number; y: number; w: number; h: number; png: Uint8Array }
  | { t: 'stamp'; x: number; y: number; w: number; h: number; label: string }
);
export type AnnMap = Record<number, Ann[]>;

const col = (c: RGB) => rgb(c[0] / 255, c[1] / 255, c[2] / 255);

export async function applyAnnotations(bytes: Uint8Array, anns: AnnMap, render?: TextImageRenderer): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const td = new TextDrawer(doc, render);
  const pages = doc.getPages();
  for (const [piStr, list] of Object.entries(anns)) {
    const page = pages[+piStr];
    if (!page || !list.length) continue;
    const H = visibleFrame(page).h;
    const U = (x: number, y: number) => toUser(page, x, H - y, 0); // 視覺(左上) → 使用者空間
    const seg = (x1: number, y1: number, x2: number, y2: number, thickness: number, color: RGB, opacity = 1) => {
      const a = U(x1, y1), b = U(x2, y2);
      page.drawLine({ start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, thickness, color: col(color), opacity, lineCap: LineCapStyle.Round });
    };
    for (const a of list) {
      switch (a.t) {
        case 'highlight': {
          const o = toUser(page, a.x, H - a.y - a.h, 0);
          page.drawRectangle({ x: o.x, y: o.y, width: a.w, height: a.h, rotate: degrees(o.angle), color: col(a.color), blendMode: BlendMode.Multiply });
          break;
        }
        case 'underline': seg(a.x, a.y + a.h, a.x + a.w, a.y + a.h, 1.2, a.color); break;
        case 'strike': seg(a.x, a.y + a.h / 2, a.x + a.w, a.y + a.h / 2, 1.2, a.color); break;
        case 'squiggly': {
          const step = 3, amp = 1.6, y0 = a.y + a.h;
          let px = a.x, py = y0, up = true;
          for (let x = a.x + step; x <= a.x + a.w + step; x += step) {
            const nx = Math.min(x, a.x + a.w), ny = y0 + (up ? -amp : amp);
            seg(px, py, nx, ny, 0.9, a.color); px = nx; py = ny; up = !up;
          }
          break;
        }
        case 'rect': {
          const o = toUser(page, a.x, H - a.y - a.h, 0);
          page.drawRectangle({ x: o.x, y: o.y, width: a.w, height: a.h, rotate: degrees(o.angle), borderColor: col(a.color), borderWidth: a.width,
            ...(a.fill ? { color: col(a.color), opacity: 0.25, borderOpacity: 1 } : {}) });
          break;
        }
        case 'ellipse': {
          const c = toUser(page, a.x + a.w / 2, H - (a.y + a.h / 2), 0);
          page.drawEllipse({ x: c.x, y: c.y, xScale: a.w / 2, yScale: a.h / 2, rotate: degrees(c.angle), borderColor: col(a.color), borderWidth: a.width,
            ...(a.fill ? { color: col(a.color), opacity: 0.25, borderOpacity: 1 } : {}) });
          break;
        }
        case 'line': seg(a.x1, a.y1, a.x2, a.y2, a.width, a.color); break;
        case 'arrow': {
          seg(a.x1, a.y1, a.x2, a.y2, a.width, a.color);
          const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1), L = 10 + a.width * 2;
          for (const s of [-1, 1]) seg(a.x2, a.y2, a.x2 - L * Math.cos(ang + s * 0.45), a.y2 - L * Math.sin(ang + s * 0.45), a.width, a.color);
          break;
        }
        case 'ink':
          for (let i = 1; i < a.pts.length; i++) seg(a.pts[i - 1][0], a.pts[i - 1][1], a.pts[i][0], a.pts[i][1], a.width, a.color);
          if (a.pts.length === 1) seg(a.pts[0][0], a.pts[0][1], a.pts[0][0] + 0.1, a.pts[0][1], a.width, a.color);
          break;
        case 'text': {
          const st = { size: a.size, color: a.color, opacity: 1, font: 'Helvetica' as const, bold: a.bold };
          let lineNo = 0;
          for (const para of a.text.split('\n')) {
            for (const line of await wrapLine(td, para, st, a.w)) {
              const m = await td.measure(line || ' ', st);
              const cy = H - (a.y + a.size * 1.25 * (lineNo + 0.5));
              if (line) await td.drawCentered(page, line, st, a.x + m.w / 2, cy, 0);
              lineNo++;
            }
          }
          break;
        }
        case 'image': {
          const img = await doc.embedPng(a.png);
          const o = toUser(page, a.x, H - a.y - a.h, 0);
          page.drawImage(img, { x: o.x, y: o.y, width: a.w, height: a.h, rotate: degrees(o.angle) });
          break;
        }
        case 'stamp': {
          const o = toUser(page, a.x, H - a.y - a.h, 0);
          page.drawRectangle({ x: o.x, y: o.y, width: a.w, height: a.h, rotate: degrees(o.angle), borderColor: col(a.color), borderWidth: 2 });
          const st = { size: Math.min(a.h * 0.55, a.w / Math.max(2, a.label.length) * 1.6), color: a.color, opacity: 1, font: 'Helvetica' as const, bold: true };
          await td.drawCentered(page, a.label, st, a.x + a.w / 2, H - (a.y + a.h / 2), 0);
          break;
        }
        case 'note': {
          const p1 = U(a.x, a.y + 20), p2 = U(a.x + 20, a.y);
          const rect = [Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.max(p1.x, p2.x), Math.max(p1.y, p2.y)];
          const ref = doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Text', Rect: rect, Contents: PDFHexString.fromText(a.text), Name: 'Note', T: PDFHexString.fromText('PDF 工具箱'),
            C: [a.color[0] / 255, a.color[1] / 255, a.color[2] / 255], F: 4, Open: false,
          }));
          page.node.addAnnot(ref);
          break;
        }
      }
    }
  }
  return savePdf(doc);
}

async function wrapLine(td: TextDrawer, text: string, st: Parameters<TextDrawer['measure']>[1], maxW: number): Promise<string[]> {
  if (!text) return [''];
  const out: string[] = [];
  let cur = '';
  for (const ch of Array.from(text)) {
    const trial = cur + ch;
    if ((await td.measure(trial, st)).w > maxW && cur) { out.push(cur); cur = ch; } else cur = trial;
  }
  out.push(cur);
  return out;
}
