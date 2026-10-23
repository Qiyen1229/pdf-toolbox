import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString, PDFHexString, PDFStream, PDFRawStream, PDFDocument, PDFPage } from 'pdf-lib';
import { loadPdf, savePdf } from './pdf';

// ---------- 書籤 ----------
export interface Bookmark { title: string; page: number /* 0-based */; children?: Bookmark[] }

export async function writeBookmarks(bytes: Uint8Array, items: Bookmark[]): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const ctx = doc.context;
  const pages = doc.getPages();
  if (!items.length) { doc.catalog.delete(PDFName.of('Outlines')); return savePdf(doc); }
  const outlinesRef = ctx.nextRef();

  function build(list: Bookmark[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } {
    const refs = list.map(() => ctx.nextRef());
    let count = list.length;
    list.forEach((b, i) => {
      const pg = pages[Math.min(Math.max(b.page, 0), pages.length - 1)];
      const dict = ctx.obj({
        Title: PDFHexString.fromText(b.title || '(未命名)'),
        Parent: parent,
        Dest: [pg.ref, PDFName.of('Fit')],
      }) as PDFDict;
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      if (b.children?.length) {
        const c = build(b.children, refs[i]);
        dict.set(PDFName.of('First'), c.first); dict.set(PDFName.of('Last'), c.last);
        dict.set(PDFName.of('Count'), PDFNumber.of(c.count));
        count += c.count;
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  }
  const root = build(items, outlinesRef);
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: root.first, Last: root.last, Count: root.count }));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  return savePdf(doc);
}

// ---------- 超連結 ----------
export interface LinkInfo { page: number; index: number; kind: 'uri' | 'internal' | 'other'; target: string; rect: [number, number, number, number] }

export async function listLinks(bytes: Uint8Array): Promise<LinkInfo[]> {
  const doc = await loadPdf(bytes);
  const out: LinkInfo[] = [];
  doc.getPages().forEach((p, pi) => {
    const annots = p.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookupMaybe(i, PDFDict);
      if (!a || a.get(PDFName.of('Subtype')) !== PDFName.of('Link')) continue;
      const rect = (a.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray() ?? []).map((n) => (n as PDFNumber).asNumber()) as [number, number, number, number];
      const act = a.lookupMaybe(PDFName.of('A'), PDFDict);
      let kind: LinkInfo['kind'] = 'other', target = '';
      const uri = act?.get(PDFName.of('URI'));
      if (uri instanceof PDFString || uri instanceof PDFHexString) { kind = 'uri'; target = uri.decodeText(); }
      else if (a.has(PDFName.of('Dest')) || act?.has(PDFName.of('D'))) { kind = 'internal'; target = '（文件內跳轉）'; }
      out.push({ page: pi, index: i, kind, target, rect });
    }
  });
  return out;
}
export async function removeLinks(bytes: Uint8Array, which: { page: number; index: number }[]): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const byPage = new Map<number, number[]>();
  for (const w of which) byPage.set(w.page, [...(byPage.get(w.page) ?? []), w.index]);
  for (const [pi, idxs] of byPage) {
    const annots = doc.getPages()[pi].node.Annots();
    if (!annots) continue;
    for (const i of idxs.sort((a, b) => b - a)) annots.remove(i);
  }
  return savePdf(doc);
}
export async function addLink(bytes: Uint8Array, page: number, rect: [number, number, number, number], uri: string): Promise<Uint8Array> {
  if (!/^(https?:|mailto:|tel:)/i.test(uri)) throw new Error('僅允許 http(s)、mailto、tel 連結');
  const doc = await loadPdf(bytes);
  const p = doc.getPages()[page];
  const ref = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], F: 4,
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) },
  }));
  p.node.addAnnot(ref);
  return savePdf(doc);
}

// ---------- 文件資訊 ----------
export interface DocInfo {
  pages: number; version: string; encrypted: boolean; sizeBytes: number;
  fonts: { name: string; type: string; embedded: boolean }[];
  images: { width: number; height: number; filter: string; colorSpace: string }[];
  formFields: number; annotations: number; hasOutline: boolean;
  pageSizes: { w: number; h: number; count: number }[];
  hasSignature: boolean;
}
const nameOf = (o: any) => (o instanceof PDFName ? o.decodeText() : '');
export async function docInfo(bytes: Uint8Array): Promise<DocInfo> {
  const doc = await loadPdf(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 16)).match(/%PDF-(\d\.\d)/);
  const fonts = new Map<string, { name: string; type: string; embedded: boolean }>();
  const images: DocInfo['images'] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : (obj as any).dict instanceof PDFDict ? (obj as any).dict as PDFDict : null;
    if (!dict) continue;
    const type = nameOf(dict.get(PDFName.of('Type'))), sub = nameOf(dict.get(PDFName.of('Subtype')));
    if (type === 'Font' && sub !== 'CIDFontType0' && sub !== 'CIDFontType2') {
      const base = nameOf(dict.get(PDFName.of('BaseFont'))).replace(/^[A-Z]{6}\+/, '') || '(未命名)';
      let embedded = false;
      const check = (d?: PDFDict | null) => {
        const fd = d?.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
        if (fd && (fd.has(PDFName.of('FontFile')) || fd.has(PDFName.of('FontFile2')) || fd.has(PDFName.of('FontFile3')))) embedded = true;
      };
      check(dict);
      const desc = dict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
      if (desc) check(desc.lookupMaybe(0, PDFDict));
      const key = base + sub;
      if (!fonts.has(key) || embedded) fonts.set(key, { name: base, type: sub, embedded });
    } else if (sub === 'Image') {
      const w = (dict.get(PDFName.of('Width')) as PDFNumber | undefined)?.asNumber() ?? 0;
      const h = (dict.get(PDFName.of('Height')) as PDFNumber | undefined)?.asNumber() ?? 0;
      const fl = dict.get(PDFName.of('Filter'));
      const filter = fl instanceof PDFArray ? fl.asArray().map(nameOf).join('+') : nameOf(fl);
      const cs = dict.get(PDFName.of('ColorSpace'));
      images.push({ width: w, height: h, filter: filter || 'raw', colorSpace: cs instanceof PDFName ? nameOf(cs) : cs ? '(複合)' : '—' });
    }
  }
  const sizes = new Map<string, { w: number; h: number; count: number }>();
  let annotations = 0;
  for (const p of doc.getPages()) {
    const s = p.getSize(), k = `${s.width.toFixed(0)}x${s.height.toFixed(0)}`;
    const e = sizes.get(k); if (e) e.count++; else sizes.set(k, { w: +s.width.toFixed(1), h: +s.height.toFixed(1), count: 1 });
    annotations += p.node.Annots()?.size() ?? 0;
  }
  let formFields = 0;
  try { formFields = doc.getForm().getFields().length; } catch { /* no form */ }
  const raw = new TextDecoder('latin1').decode(bytes);
  return {
    pages: doc.getPageCount(), version: head?.[1] ?? '?', encrypted: false, sizeBytes: bytes.length,
    fonts: [...fonts.values()].sort((a, b) => a.name.localeCompare(b.name)), images,
    formFields, annotations, hasOutline: doc.catalog.has(PDFName.of('Outlines')),
    pageSizes: [...sizes.values()], hasSignature: /\/ByteRange\s*\[/.test(raw),
  };
}

// ---------- 數位簽章檢視（結構層級） ----------
export interface SigInfo {
  index: number; name?: string; reason?: string; location?: string; signingTime?: string; subFilter?: string;
  byteRange: number[]; coversWholeFile: boolean; certCount: number; contactInfo?: string;
}
/** 解析 PDF 內的簽章欄位。注意：不做密碼學驗證（需憑證鏈與信任錨），僅檢查結構並偵測「簽署後是否追加內容」。 */
export function inspectSignatures(bytes: Uint8Array): SigInfo[] {
  const text = new TextDecoder('latin1').decode(bytes);
  const out: SigInfo[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const br = [+m[1], +m[2], +m[3], +m[4]];
    const start = Math.max(0, m.index - 4000), end = Math.min(text.length, m.index + 8000);
    const near = text.slice(start, end);
    const str = (k: string) => {
      const r = near.match(new RegExp(`/${k}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`)) ;
      return r ? r[1].replace(/\\([()\\])/g, '$1') : undefined;
    };
    const sub = near.match(/\/SubFilter\s*\/([A-Za-z0-9_.]+)/)?.[1];
    const contents = near.match(/\/Contents\s*<([0-9A-Fa-f\s]*)>/)?.[1].replace(/\s/g, '') ?? '';
    const certs = (contents.match(/3082[0-9a-f]{4}3082/gi) ?? []).length;
    out.push({
      index: out.length, name: str('Name'), reason: str('Reason'), location: str('Location'), contactInfo: str('ContactInfo'),
      signingTime: str('M'), subFilter: sub, byteRange: br,
      coversWholeFile: br[2] + br[3] === bytes.length || Math.abs(br[2] + br[3] - bytes.length) <= 2,
      certCount: certs,
    });
  }
  return out;
}
