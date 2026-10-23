import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { openPdf, renderPage, canvasToBytes, freeCanvas, pageTextItems, type TextItem, destroyPdf } from '../lib/pdfjs';
import { savePdf, parseRanges } from './ops/pdf';
import { TextDrawer, type TextImageRenderer } from './ops/stamp';
import type { Progress } from './raster';

// ---------- 版面分析（行/欄） ----------
export interface Line { y: number; size: number; items: { text: string; x: number; w: number }[]; text: string }
function groupLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const l = lines.find((L) => Math.abs(L.y - it.y) < Math.max(2, it.h * 0.5));
    if (l) { l.items.push({ text: it.str, x: it.x, w: it.w }); l.size = Math.max(l.size, it.h); }
    else lines.push({ y: it.y, size: it.h, items: [{ text: it.str, x: it.x, w: it.w }], text: '' });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    let s = '', end = -Infinity;
    for (const i of l.items) {
      const gap = i.x - end;
      const cjk = /[㐀-鿿]/.test(i.text[0] ?? '');
      s += (end > -Infinity && gap > l.size * 0.25 && !cjk ? ' ' : '') + i.text;
      end = i.x + i.w;
    }
    l.text = s.trimEnd();
  }
  return lines.sort((a, b) => a.y - b.y);
}
export interface PageText { page: number; lines: Line[]; text: string }
export async function extractText(bytes: Uint8Array, opt: { pages?: string; password?: string } = {}, onProgress?: Progress): Promise<PageText[]> {
  const pdf = await openPdf(bytes, opt.password);
  const idx = parseRanges(opt.pages ?? '', pdf.numPages);
  const out: PageText[] = [];
  try {
    for (let k = 0; k < idx.length; k++) {
      onProgress?.(k + 1, idx.length, '擷取文字');
      const page = await pdf.getPage(idx[k] + 1);
      const lines = groupLines(await pageTextItems(page));
      out.push({ page: idx[k] + 1, lines, text: lines.map((l) => l.text).join('\n') });
      page.cleanup();
    }
  } finally { await destroyPdf(pdf); }
  return out;
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 10; };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BULLET = /^\s*([•●○▪■◆\-–*]|\d+[.)、])\s+/;

export function toPlainText(pages: PageText[]): string {
  return pages.map((p) => p.text).join('\n\n\f\n');
}
/** 啟發式：字級明顯大於內文者視為標題；項目符號轉清單。精度有限，詳見「已知限制」。 */
export function toMarkdown(pages: PageText[]): string {
  const body = median(pages.flatMap((p) => p.lines.map((l) => l.size)));
  const out: string[] = [];
  for (const p of pages) {
    let para: string[] = [];
    const flush = () => { if (para.length) { out.push(para.join(' ')); para = []; } };
    for (const l of p.lines) {
      const r = l.size / body;
      if (!l.text.trim()) { flush(); continue; }
      if (r >= 1.5 && l.text.length < 120) { flush(); out.push(`# ${l.text}`); }
      else if (r >= 1.2 && l.text.length < 120) { flush(); out.push(`## ${l.text}`); }
      else if (BULLET.test(l.text)) { flush(); out.push(`- ${l.text.replace(BULLET, '')}`); }
      else para.push(l.text);
    }
    flush();
    out.push('\n---\n');
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n');
}
export function toHtml(pages: PageText[], title = 'document'): string {
  const body = median(pages.flatMap((p) => p.lines.map((l) => l.size)));
  const sec = pages.map((p) => {
    const parts: string[] = [];
    let list = false;
    for (const l of p.lines) {
      const r = l.size / body;
      const isLi = BULLET.test(l.text);
      if (list && !isLi) { parts.push('</ul>'); list = false; }
      if (r >= 1.5 && l.text.length < 120) parts.push(`<h1>${esc(l.text)}</h1>`);
      else if (r >= 1.2 && l.text.length < 120) parts.push(`<h2>${esc(l.text)}</h2>`);
      else if (isLi) { if (!list) { parts.push('<ul>'); list = true; } parts.push(`<li>${esc(l.text.replace(BULLET, ''))}</li>`); }
      else parts.push(`<p>${esc(l.text)}</p>`);
    }
    if (list) parts.push('</ul>');
    return `<section data-page="${p.page}">\n${parts.join('\n')}\n</section>`;
  });
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,"PingFang TC","Microsoft JhengHei",sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.7}section{border-bottom:1px solid #ddd;padding-bottom:1rem;margin-bottom:1rem}</style></head><body>\n${sec.join('\n')}\n</body></html>`;
}

// ---------- 最小 OOXML 寫入器 ----------
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const xesc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 文字為主的 DOCX（保留段落與標題層級；不含版面、表格、圖片）。 */
export async function toDocx(pages: PageText[]): Promise<Uint8Array> {
  const body = median(pages.flatMap((p) => p.lines.map((l) => l.size)));
  const paras: string[] = [];
  pages.forEach((p, pi) => {
    for (const l of p.lines) {
      const r = l.size / body;
      const sz = r >= 1.5 ? 36 : r >= 1.2 ? 28 : 22;
      const bold = r >= 1.2 ? '<w:b/>' : '';
      paras.push(`<w:p><w:r><w:rPr>${bold}<w:sz w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${xesc(l.text)}</w:t></w:r></w:p>`);
    }
    if (pi < pages.length - 1) paras.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  });
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const colName = (n: number) => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
/** 每頁一個工作表；同一行內間距較大的文字視為不同欄。非表格偵測，僅適合簡單表格型 PDF。 */
export async function toXlsx(pages: PageText[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const sheets = pages.map((p, i) => {
    const rows = p.lines.map((l, r) => {
      const cells: { t: string }[] = [];
      let cur = '', end = -Infinity;
      for (const it of l.items) {
        if (end > -Infinity && it.x - end > l.size * 1.2) { cells.push({ t: cur }); cur = ''; }
        cur += (cur && it.x - end > l.size * 0.25 ? ' ' : '') + it.text; end = it.x + it.w;
      }
      cells.push({ t: cur });
      return `<row r="${r + 1}">${cells.map((c, ci) => `<c r="${colName(ci)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xesc(c.t)}</t></is></c>`).join('')}</row>`;
    });
    return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  });
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((_, i) => `<sheet name="Page ${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, s));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** 每頁一張全幅圖片的 PPTX（版面與外觀精確，但文字不可編輯）。 */
export async function toPptx(bytes: Uint8Array, opt: { dpi: number; password?: string }, onProgress?: Progress): Promise<Uint8Array> {
  const pdf = await openPdf(bytes, opt.password);
  const zip = new JSZip();
  const n = pdf.numPages;
  const EMU = 12700; // 1pt
  let cx = 0, cy = 0;
  try {
    for (let i = 1; i <= n; i++) {
      onProgress?.(i, n, '輸出投影片');
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      if (i === 1) { cx = Math.round(vp.width * EMU); cy = Math.round(vp.height * EMU); }
      const c = await renderPage(page, opt.dpi / 72);
      zip.file(`ppt/media/image${i}.jpg`, await canvasToBytes(c, 'image/jpeg', 0.85));
      freeCanvas(c);
      const w = Math.round(vp.width * EMU), h = Math.round(vp.height * EMU);
      zip.file(`ppt/slides/slide${i}.xml`, `${XML}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${i}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round((cx - w) / 2)}" y="${Math.round((cy - h) / 2)}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
      zip.file(`ppt/slides/_rels/slide${i}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i}.jpg"/></Relationships>`);
      page.cleanup();
    }
  } finally { await destroyPdf(pdf); }
  const slides = Array.from({ length: n }, (_, i) => i + 1);
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides.map((i) => `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file('ppt/presentation.xml', `${XML}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((i) => `<p:sldId id="${255 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides.map((i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`).join('')}</Relationships>`);
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const grp = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  zip.file('ppt/slideMasters/slideMaster1.xml', `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${grp}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`);
  zip.file('ppt/slideLayouts/slideLayout1.xml', `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${grp}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const ln = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>';
  zip.file('ppt/theme/theme1.xml', `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="4F46E5"/></a:accent1><a:accent2><a:srgbClr val="EF4444"/></a:accent2><a:accent3><a:srgbClr val="10B981"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="3B82F6"/></a:accent5><a:accent6><a:srgbClr val="8B5CF6"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${ln}${ln}${ln}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// ---------- 純文字 → PDF ----------
export async function textToPdf(text: string, opt: { size: number; margin: number; pageSize: [number, number] }, render?: TextImageRenderer): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const td = new TextDrawer(doc, render);
  const [W, H] = opt.pageSize;
  const lead = opt.size * 1.5;
  let page = doc.addPage([W, H]);
  let y = H - opt.margin - opt.size;
  const maxW = W - 2 * opt.margin;
  const LATIN = /^[ -~ -ÿ\t]*$/;
  const newPage = () => { page = doc.addPage([W, H]); y = H - opt.margin - opt.size; };
  const wrap = (line: string): string[] => {
    // 逐字量測換行（CJK 無空白，因此以字為單位）
    const out: string[] = []; let cur = '';
    const width = (s: string) => font.widthOfTextAtSize(s, opt.size);
    for (const ch of Array.from(line)) {
      const trial = cur + ch;
      const w = LATIN.test(trial) ? width(trial) : trial.length * opt.size * 1.0;
      if (w > maxW && cur) { out.push(cur); cur = ch; } else cur = trial;
    }
    out.push(cur);
    return out;
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    for (const seg of wrap(raw.replace(/\t/g, '    '))) {
      if (y < opt.margin) newPage();
      if (seg) {
        if (LATIN.test(seg)) page.drawText(seg, { x: opt.margin, y, size: opt.size, font, color: rgb(0, 0, 0) });
        else if (render) {
          const m = await td.measure(seg, { size: opt.size, color: [0, 0, 0], opacity: 1, font: 'Helvetica' });
          page.drawImage(m.img!, { x: opt.margin, y: y - opt.size * 0.25, width: m.w, height: m.h });
        } else throw new Error('文字包含非拉丁字元，需在瀏覽器中執行');
      }
      y -= lead;
    }
  }
  return savePdf(doc);
}
