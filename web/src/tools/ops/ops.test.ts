import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import {
  parseRanges, mergePdfs, splitPdf, rebuildPages, rotatePdf, cropMargins, resizePages, repairPdf, stripMetadata,
  writeMetadata, readMetadata, loadPdf, extractPages, toUser, visibleFrame, PAGE_SIZES,
} from './pdf';
import { stampPages, watermark, expandTemplate } from './stamp';
import { fillForm, listFormFields, createFormFields, flattenForm } from './forms';
import { writeBookmarks, listLinks, addLink, removeLinks, docInfo, inspectSignatures } from './structure';

async function makePdf(pages = 3, size: [number, number] = [300, 400]) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage(size).drawText(`Page ${i + 1}`, { x: 20, y: 200, size: 24, font: f });
  d.setTitle('Secret Title'); d.setAuthor('Alice');
  return d.save();
}
const count = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();

describe('parseRanges', () => {
  it('handles ranges, lists, open ends, odd/even', () => {
    expect(parseRanges('1-3,5', 6)).toEqual([0, 1, 2, 4]);
    expect(parseRanges('4-', 6)).toEqual([3, 4, 5]);
    expect(parseRanges('-2', 6)).toEqual([0, 1]);
    expect(parseRanges('odd', 5)).toEqual([0, 2, 4]);
    expect(parseRanges('last', 5)).toEqual([4]);
    expect(parseRanges('', 3)).toEqual([0, 1, 2]);
    expect(parseRanges('3-1', 3)).toEqual([2, 1, 0]);
  });
  it('rejects invalid', () => {
    expect(() => parseRanges('9', 3)).toThrow(/超出範圍/);
    expect(() => parseRanges('abc', 3)).toThrow();
    expect(() => parseRanges('0', 3)).toThrow();
  });
});

describe('page operations', () => {
  it('merges with per-file ranges', async () => {
    const a = await makePdf(3), b = await makePdf(2);
    expect(await count(await mergePdfs([{ bytes: a }, { bytes: b, pages: '2' }]))).toBe(4);
  });
  it('splits by ranges / every N / single', async () => {
    const a = await makePdf(5);
    expect((await splitPdf(a, { mode: 'ranges', ranges: '1-2;4-5' })).length).toBe(2);
    const ev = await splitPdf(a, { mode: 'every', n: 2 });
    expect(ev.length).toBe(3);
    expect(await count(ev[2].bytes)).toBe(1);
    expect((await splitPdf(a, { mode: 'single' })).length).toBe(5);
  });
  it('rebuilds: reorder, delete, duplicate, blank, rotate', async () => {
    const a = await makePdf(3);
    const out = await rebuildPages(a, [{ src: 2 }, { src: 0, rotate: 90 }, { src: 0 }, { src: 0, blank: { w: 200, h: 200 } }]);
    const d = await PDFDocument.load(out);
    expect(d.getPageCount()).toBe(4);
    expect(d.getPage(1).getRotation().angle).toBe(90);
    expect(d.getPage(3).getSize()).toEqual({ width: 200, height: 200 });
  });
  it('rotates selected pages, cumulative and normalized', async () => {
    const a = await makePdf(3);
    const r1 = await rotatePdf(a, 90, '2');
    const r2 = await rotatePdf(r1, 270, '2');
    const d = await PDFDocument.load(r2);
    expect(d.getPage(1).getRotation().angle).toBe(0);
    const d1 = await PDFDocument.load(r1);
    expect(d1.getPage(0).getRotation().angle).toBe(0);
    expect(d1.getPage(1).getRotation().angle).toBe(90);
  });
  it('crops margins & errors if too small', async () => {
    const a = await makePdf(1);
    const out = await cropMargins(a, { top: 10, right: 20, bottom: 30, left: 40 });
    const p = (await PDFDocument.load(out)).getPage(0);
    expect(p.getCropBox().width).toBe(300 - 60);
    expect(p.getCropBox().height).toBe(400 - 40);
    await expect(cropMargins(a, { top: 0, right: 0, bottom: 0, left: 290 })).rejects.toThrow();
  });
  it('resizes to A4 with orientation handling, including rotated source pages', async () => {
    const a = await makePdf(2, [200, 100]); // landscape
    const rotated = await rotatePdf(a, 90, '2');
    const out = await resizePages(rotated, { size: PAGE_SIZES.A4, orientation: 'auto', fit: 'contain' });
    const d = await PDFDocument.load(out);
    expect(d.getPageCount()).toBe(2);
    const p0 = d.getPage(0).getSize(), p1 = d.getPage(1).getSize();
    expect(p0.width).toBeGreaterThan(p0.height);   // 橫向來源 → 橫向 A4
    expect(p1.height).toBeGreaterThan(p1.width);   // 旋轉 90 後為直向
  });
  it('extractPages', async () => {
    expect(await count(await extractPages(await makePdf(5), [4, 0]))).toBe(2);
  });
});

describe('coordinates', () => {
  it('toUser maps visual↔user space for rotated pages', async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([200, 100]);
    p.setRotation(degrees(90));
    const f = visibleFrame(p);
    expect([f.w, f.h]).toEqual([100, 200]);
    // 視覺左下 (0,0) 對應使用者空間 (0,0)? rot90: x = rw - vy, y = vx → (200, 0)
    expect(toUser(p, 0, 0)).toMatchObject({ x: 200, y: 0 });
    expect(toUser(p, 0, 0).angle).toBe(90);
  });
});

describe('repair / metadata', () => {
  it('repairs a PDF with a corrupted xref', async () => {
    const a = await makePdf(2);
    const s = Array.from(a, (c) => String.fromCharCode(c)).join('');
    const broken = Uint8Array.from(s.replace(/startxref\s+\d+/, 'startxref\n99999999'), (c) => c.charCodeAt(0));
    const r = await repairPdf(broken);
    expect(await count(r.bytes)).toBe(2);
  });
  it('strips Info and XMP metadata', async () => {
    const a = await makePdf(1);
    const withXmp = await PDFDocument.load(a);
    const stream = withXmp.context.stream('<x:xmpmeta>Alice</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' });
    withXmp.catalog.set(PDFName.of('Metadata'), withXmp.context.register(stream));
    const out = await stripMetadata(await withXmp.save());
    const text = new TextDecoder('latin1').decode(out);
    expect(text).not.toContain('Alice');
    expect(text).not.toContain('Secret Title');
    expect(text).not.toContain('xmpmeta');
    expect((await readMetadata(out)).title ?? '').toBe('');
  });
  it('writes metadata', async () => {
    const out = await writeMetadata(await makePdf(1), { title: '新標題', keywords: 'a, b' });
    expect((await readMetadata(out)).title).toBe('新標題');
  });
});

describe('stamping', () => {
  it('expands template tokens', () => {
    const s = expandTemplate('{page}/{pages} {file} {bates}', { page: 2, pages: 9, seq: 4, startNumber: 0, fileName: 'a.pdf', now: new Date(2024, 0, 5),
      bates: { prefix: 'ABC-', digits: 5, start: 100, suffix: '' } });
    expect(s).toBe('2/9 a.pdf ABC-00104');
  });
  it('adds page numbers to selected pages', async () => {
    const out = await stampPages(await makePdf(3), { template: 'Page {page} of {pages}', anchor: 'bc', margin: 20, pages: '2-3',
      style: { size: 10, color: [0, 0, 0], opacity: 1, font: 'Helvetica' } });
    expect(await count(out)).toBe(3);
    expect(out.length).toBeGreaterThan((await makePdf(3)).length);
  });
  it('non-latin text without renderer errors clearly, with renderer succeeds', async () => {
    const a = await makePdf(1);
    const st = { size: 12, color: [0, 0, 0] as [number, number, number], opacity: 1, font: 'Helvetica' as const };
    await expect(stampPages(a, { template: '機密', anchor: 'tc', margin: 10, style: st })).rejects.toThrow();
    // 1×1 透明 PNG 當作假渲染器
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const out = await stampPages(a, { template: '機密', anchor: 'tc', margin: 10, style: st }, async () => ({ png, width: 30, height: 12 }));
    expect(await count(out)).toBe(1);
  });
  it('watermark tiled & single', async () => {
    const st = { size: 40, color: [200, 0, 0] as [number, number, number], opacity: 0.3, font: 'Helvetica' as const, bold: true };
    const a = await makePdf(2);
    const one = await watermark(a, { kind: 'text', text: 'DRAFT', style: st, rotate: 45, tile: false });
    const tiled = await watermark(a, { kind: 'text', text: 'DRAFT', style: st, rotate: 45, tile: true });
    expect(tiled.length).toBeGreaterThan(one.length);
  });
});

describe('forms', () => {
  it('creates fields, lists, fills and flattens', async () => {
    const created = await createFormFields(await makePdf(1), [
      { kind: 'text', name: 'fullname', page: 0, x: 20, y: 20, w: 150, h: 24 },
      { kind: 'checkbox', name: 'agree', page: 0, x: 20, y: 60, w: 16, h: 16 },
      { kind: 'dropdown', name: 'city', page: 0, x: 20, y: 90, w: 120, h: 22, options: ['Taipei', 'Tokyo'] },
      { kind: 'radio', name: 'size', page: 0, x: 20, y: 130, w: 14, h: 14, options: ['S'] },
      { kind: 'date', name: 'when', page: 0, x: 20, y: 160, w: 100, h: 22 },
    ]);
    const list = await listFormFields(created);
    expect(list.map((f) => f.name).sort()).toEqual(['agree', 'city', 'fullname', 'size', 'when']);
    const filled = await fillForm(created, { fullname: 'Bob', agree: true, city: 'Tokyo' });
    const after = await listFormFields(filled);
    expect(after.find((f) => f.name === 'fullname')!.value).toBe('Bob');
    expect(after.find((f) => f.name === 'agree')!.value).toBe(true);
    expect(after.find((f) => f.name === 'city')!.value).toBe('Tokyo');
    const flat = await flattenForm(filled);
    expect((await listFormFields(flat)).length).toBe(0);
  });
  it('rejects duplicate names', async () => {
    await expect(createFormFields(await makePdf(1), [
      { kind: 'text', name: 'a', page: 0, x: 0, y: 0, w: 50, h: 20 }, { kind: 'text', name: 'a', page: 0, x: 0, y: 30, w: 50, h: 20 }])).rejects.toThrow();
  });
  it('allows non-Latin (Chinese) values without requiring CJK font upload', async () => {
    const created = await createFormFields(await makePdf(1), [{ kind: 'text', name: 'n', page: 0, x: 10, y: 10, w: 100, h: 20 }]);
    const filled = await fillForm(created, { n: '王小明' });
    const fields = await listFormFields(filled);
    expect(fields.find((f) => f.name === 'n')?.value).toBe('王小明');
  });
});

describe('structure', () => {
  it('writes nested bookmarks readable by pdf-lib structure', async () => {
    const out = await writeBookmarks(await makePdf(3), [{ title: '第一章', page: 0, children: [{ title: '1.1', page: 1 }] }, { title: '第二章', page: 2 }]);
    const d = await PDFDocument.load(out);
    const outlines = d.catalog.lookup(PDFName.of('Outlines'), (await import('pdf-lib')).PDFDict);
    expect((outlines.get(PDFName.of('Count')) as any).asNumber()).toBe(3);
  });
  it('adds, lists and removes links; rejects javascript: URIs', async () => {
    const a = await addLink(await makePdf(2), 1, [10, 10, 100, 40], 'https://example.com/x');
    const links = await listLinks(a);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ page: 1, kind: 'uri', target: 'https://example.com/x' });
    expect(await listLinks(await removeLinks(a, [{ page: 1, index: 0 }]))).toHaveLength(0);
    await expect(addLink(await makePdf(1), 0, [0, 0, 1, 1], 'javascript:alert(1)')).rejects.toThrow();
  });
  it('doc info reports fonts / page sizes', async () => {
    const info = await docInfo(await makePdf(3));
    expect(info.pages).toBe(3);
    expect(info.fonts.some((f) => f.name === 'Helvetica')).toBe(true);
    expect(info.pageSizes).toEqual([{ w: 300, h: 400, count: 3 }]);
    expect(info.hasSignature).toBe(false);
  });
  it('inspects a synthetic signature dictionary', () => {
    const fake = `%PDF-1.7\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (Alice Chen) /M (D:20240102030405Z) /ByteRange [0 100 200 50] /Contents <${'30'.repeat(10)}> >>\n`;
    const s = inspectSignatures(new TextEncoder().encode(fake));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ name: 'Alice Chen', subFilter: 'adbe.pkcs7.detached', coversWholeFile: false });
  });
});

import { diffText } from '../textdiff';
describe('diffText', () => {
  it('finds additions and deletions', () => {
    const d = diffText('合約金額為 100 元', '合約金額為 200 元');
    expect(d.some((p) => p.type === 'del' && p.text.includes('100'))).toBe(true);
    expect(d.some((p) => p.type === 'add' && p.text.includes('200'))).toBe(true);
    expect(diffText('same', 'same')).toEqual([{ type: 'same', text: 'same' }]);
  });
});

import { applyAnnotations } from './annotate';
describe('annotations', () => {
  it('applies every annotation type on normal and rotated pages', async () => {
    const base = await rotatePdf(await makePdf(2), 90, '2');
    const c: [number, number, number] = [255, 200, 0];
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
    const list = (pfx: string) => [
      { id: pfx + '1', color: c, t: 'highlight' as const, x: 10, y: 10, w: 80, h: 14 },
      { id: pfx + '2', color: c, t: 'underline' as const, x: 10, y: 30, w: 80, h: 14 },
      { id: pfx + '3', color: c, t: 'strike' as const, x: 10, y: 50, w: 80, h: 14 },
      { id: pfx + '4', color: c, t: 'squiggly' as const, x: 10, y: 70, w: 80, h: 14 },
      { id: pfx + '5', color: c, t: 'rect' as const, x: 10, y: 90, w: 40, h: 20, fill: true, width: 2 },
      { id: pfx + '6', color: c, t: 'ellipse' as const, x: 60, y: 90, w: 40, h: 20, fill: false, width: 2 },
      { id: pfx + '7', color: c, t: 'line' as const, x1: 0, y1: 0, x2: 50, y2: 50, width: 2 },
      { id: pfx + '8', color: c, t: 'arrow' as const, x1: 0, y1: 100, x2: 50, y2: 150, width: 2 },
      { id: pfx + '9', color: c, t: 'ink' as const, pts: [[1, 1], [5, 9], [9, 3]] as [number, number][], width: 2 },
      { id: pfx + 'a', color: c, t: 'text' as const, x: 20, y: 200, w: 120, text: 'Hello world, this is a long line that should wrap\nsecond', size: 12 },
      { id: pfx + 'b', color: c, t: 'note' as const, x: 100, y: 100, text: '備註 note' },
      { id: pfx + 'c', color: c, t: 'image' as const, x: 100, y: 200, w: 40, h: 20, png },
      { id: pfx + 'd', color: [200, 0, 0] as [number, number, number], t: 'stamp' as const, x: 100, y: 250, w: 100, h: 30, label: 'APPROVED' },
    ];
    const out = await applyAnnotations(base, { 0: list('a'), 1: list('b') });
    const d = await PDFDocument.load(out);
    expect(d.getPageCount()).toBe(2);
    expect(d.getPage(0).node.Annots()?.size()).toBe(1); // 便利貼為真實註解
    expect(out.length).toBeGreaterThan(base.length);
  });
});

import { stripJpegMetadata } from './pdf';
describe('jpeg metadata', () => {
  it('removes APP1 (EXIF) segments and keeps the rest intact', () => {
    const exif = [0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x47, 0x50]; // "Exif..GP"
    const dqt = [0xff, 0xdb, 0x00, 0x04, 0x01, 0x02];
    const jpg = Uint8Array.from([0xff, 0xd8, ...exif, ...dqt, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
    const r = stripJpegMetadata(jpg);
    expect(r.removed).toBe(12);
    expect(Array.from(r.bytes.subarray(0, 4))).toEqual([0xff, 0xd8, 0xff, 0xdb]);
    expect(r.bytes.length).toBe(jpg.length - 12);
    expect(Array.from(r.bytes.slice(-2))).toEqual([0xff, 0xd9]);
  });
});

import { toPlainText, toMarkdown, toHtml, toDocx, toXlsx, type PageText } from '../convert';
import JSZip from 'jszip';
describe('conversions (text & office)', () => {
  const samplePages: PageText[] = [{
    page: 1,
    lines: [
      { y: 10, size: 24, items: [{ text: 'Main Title', x: 10, w: 100 }], text: 'Main Title' },
      { y: 40, size: 12, items: [{ text: '• Item A', x: 10, w: 50 }], text: '• Item A' },
      { y: 60, size: 12, items: [{ text: 'Col 1', x: 10, w: 30 }, { text: 'Col 2', x: 80, w: 30 }], text: 'Col 1  Col 2' }
    ],
    text: 'Main Title\n• Item A\nCol 1  Col 2'
  }];

  it('toPlainText produces string', () => {
    const t = toPlainText(samplePages);
    expect(t).toContain('Main Title');
  });

  it('toMarkdown heuristic headings and lists', () => {
    const md = toMarkdown(samplePages);
    expect(md).toContain('# Main Title');
    expect(md).toContain('- Item A');
  });

  it('toHtml generates valid html structure', () => {
    const html = toHtml(samplePages, 'Test Doc');
    expect(html).toContain('<h1>Main Title</h1>');
    expect(html).toContain('<li>Item A</li>');
  });

  it('toDocx generates valid zip with document.xml', async () => {
    const docxBytes = await toDocx(samplePages);
    const zip = await JSZip.loadAsync(docxBytes);
    expect(zip.file('word/document.xml')).not.toBeNull();
    const docXml = await zip.file('word/document.xml')!.async('text');
    expect(docXml).toContain('Main Title');
  });

  it('toXlsx generates valid zip with worksheets', async () => {
    const xlsxBytes = await toXlsx(samplePages);
    const zip = await JSZip.loadAsync(xlsxBytes);
    expect(zip.file('xl/worksheets/sheet1.xml')).not.toBeNull();
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
    expect(sheetXml).toContain('Col 1');
  });
});
