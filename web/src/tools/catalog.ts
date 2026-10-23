import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export type Cat = 'edit' | 'convert' | 'markup' | 'forms' | 'security' | 'advanced';
export interface ToolDef {
  id: string; cat: Cat; icon: string;
  name: { 'zh-TW': string; en: string };
  desc: { 'zh-TW': string; en: string };
  /** 無需檔案即可開啟（例如檢視器）。 */
  component: LazyExoticComponent<ComponentType<{ id: string }>>;
}
const T = (id: string, cat: Cat, icon: string, zh: string, en: string, dzh: string, den: string, loader: () => Promise<{ default: ComponentType<{ id: string }> }>): ToolDef =>
  ({ id, cat, icon, name: { 'zh-TW': zh, en }, desc: { 'zh-TW': dzh, en: den }, component: lazy(loader) });

const edit = () => import('./ui/EditTools');
const conv = () => import('./ui/ConvertTools');
const mark = () => import('./ui/MarkupTools');
const form = () => import('./ui/FormTools');
const sec = () => import('./ui/SecurityTools');
const adv = () => import('./ui/AdvancedTools');
const pick = <K extends string>(m: Promise<Record<string, any>>, k: K) => m.then((x) => ({ default: x[k] }));

export const TOOLS: ToolDef[] = [
  T('merge', 'edit', '🧩', '合併 PDF', 'Merge PDF', '多個檔案合併為一份，可排序與指定頁碼', 'Combine files, reorder and pick pages', () => pick(edit(), 'Merge')),
  T('split', 'edit', '✂️', '分割 PDF', 'Split PDF', '依頁碼範圍、每 N 頁或單頁拆分', 'Split by ranges, every N pages or per page', () => pick(edit(), 'Split')),
  T('organize', 'edit', '🗂️', '整理頁面', 'Organize pages', '縮圖拖曳排序、旋轉、刪除、複製、插入空白頁', 'Reorder, rotate, delete, duplicate, insert blank', () => pick(edit(), 'Organize')),
  T('crop', 'edit', '🔲', '裁切頁面', 'Crop pages', '以邊界或自訂區域裁切', 'Crop by margins or custom area', () => pick(edit(), 'Crop')),
  T('resize', 'edit', '📐', '頁面大小與方向', 'Page size', '轉換為 A4/Letter 等尺寸與橫直向', 'Resize to A4/Letter, change orientation', () => pick(edit(), 'Resize')),
  T('compress', 'edit', '🗜️', '壓縮 PDF', 'Compress PDF', '多段品質，顯示壓縮前後大小', 'Multiple quality levels with before/after size', () => pick(edit(), 'Compress')),
  T('repair', 'edit', '🩹', '修復 PDF', 'Repair PDF', '嘗試修復損毀或結構錯誤的檔案', 'Attempt to repair damaged files', () => pick(edit(), 'Repair')),

  T('pdf-to-image', 'convert', '🖼️', 'PDF 轉圖片', 'PDF to images', 'JPG / PNG / WebP / TIFF', 'JPG / PNG / WebP / TIFF', () => pick(conv(), 'PdfToImage')),
  T('image-to-pdf', 'convert', '📷', '圖片轉 PDF', 'Images to PDF', 'JPG / PNG / WebP / TIFF / 相片', 'JPG / PNG / WebP / TIFF / photos', () => pick(conv(), 'ImageToPdf')),
  T('pdf-to-text', 'convert', '📝', 'PDF 轉純文字', 'PDF to text', '擷取文字內容為 .txt', 'Extract text as .txt', () => pick(conv(), 'PdfToText')),
  T('pdf-to-html', 'convert', '🌐', 'PDF 轉 HTML', 'PDF to HTML', '輸出語意化 HTML（啟發式標題/清單）', 'Semantic HTML (heuristic headings/lists)', () => pick(conv(), 'PdfToHtml')),
  T('pdf-to-md', 'convert', '🔖', 'PDF 轉 Markdown', 'PDF to Markdown', '標題、清單與段落（啟發式）', 'Headings, lists and paragraphs (heuristic)', () => pick(conv(), 'PdfToMarkdown')),
  T('text-to-pdf', 'convert', '🔤', '文字轉 PDF', 'Text to PDF', '.txt / 貼上文字轉為 PDF，支援中日文', '.txt or pasted text to PDF, CJK supported', () => pick(conv(), 'TextToPdf')),
  T('pdf-to-docx', 'convert', '📘', 'PDF 轉 Word', 'PDF to Word', '文字與標題層級輸出為 .docx（本機處理）', 'Text and headings to .docx (on-device)', () => pick(conv(), 'PdfToDocx')),
  T('pdf-to-xlsx', 'convert', '📗', 'PDF 轉 Excel', 'PDF to Excel', '依文字間距分欄輸出為 .xlsx（本機處理）', 'Split columns by spacing to .xlsx (on-device)', () => pick(conv(), 'PdfToXlsx')),
  T('pdf-to-pptx', 'convert', '📙', 'PDF 轉 PowerPoint', 'PDF to PowerPoint', '每頁一張投影片（圖片）輸出為 .pptx（本機處理）', 'One image slide per page to .pptx (on-device)', () => pick(conv(), 'PdfToPptx')),

  T('annotate', 'markup', '🖍️', '註解與標記', 'Annotate', '螢光筆、底線、刪除線、波浪線、文字、便利貼、形狀、簽名、圖章', 'Highlight, text, notes, shapes, signature, stamps', () => pick(mark(), 'Annotate')),
  T('stamp', 'markup', '💧', '浮水印 / 頁首頁尾', 'Watermark & header/footer', '文字或圖片浮水印，可設透明度與角度', 'Text/image watermark, header & footer', () => pick(mark(), 'Stamp')),
  T('page-numbers', 'markup', '🔢', '頁碼 / Bates / 時間戳記', 'Page numbers & Bates', '頁碼、Bates 編號、日期時間戳記', 'Page numbers, Bates numbering, timestamps', () => pick(mark(), 'PageNumbers')),

  T('form-fill', 'forms', '✍️', '填寫表單', 'Fill form', '填寫 AcroForm 欄位並可扁平化', 'Fill AcroForm fields and flatten', () => pick(form(), 'FormFill')),
  T('form-create', 'forms', '🧱', '建立表單欄位', 'Create form fields', '文字、勾選、單選、下拉、日期', 'Text, checkbox, radio, dropdown, date', () => pick(form(), 'FormCreate')),

  T('encrypt', 'security', '🔐', '加密 PDF', 'Encrypt PDF', 'AES-256 密碼與權限（列印/複製/編輯）', 'AES-256 password and permissions', () => pick(sec(), 'Encrypt')),
  T('decrypt', 'security', '🔓', '解密 PDF', 'Decrypt PDF', '輸入密碼後移除加密', 'Remove encryption with the password', () => pick(sec(), 'Decrypt')),
  T('redact', 'security', '⬛', '塗黑 / 敏感資訊遮蔽', 'Redact', '真正移除底層文字與影像', 'True redaction that removes underlying content', () => pick(sec(), 'Redact')),
  T('signatures', 'security', '🪪', '數位簽章檢視', 'Digital signatures', '檢視簽章資訊與簽署後是否被修改', 'Inspect signatures and post-signing changes', () => pick(sec(), 'Signatures')),
  T('metadata', 'security', '🧹', '中繼資料', 'Metadata', '檢視、編輯或徹底移除作者與裝置資訊', 'View, edit or fully strip metadata', () => pick(sec(), 'Metadata')),

  T('extract-text', 'advanced', '📃', '文字擷取', 'Extract text', '逐頁檢視與複製文字', 'View and copy text per page', () => pick(adv(), 'ExtractText')),
  T('search', 'advanced', '🔎', '全文檢索', 'Full-text search', '在多份 PDF 中搜尋關鍵字', 'Search keywords across PDFs', () => pick(adv(), 'Search')),
  T('ocr', 'advanced', '👁️', 'OCR 文字辨識', 'OCR', '繁中/簡中/英文/日文，輸出可搜尋 PDF', 'zh-TW/zh-CN/EN/JA → searchable PDF', () => pick(adv(), 'Ocr')),
  T('bookmarks', 'advanced', '📑', '書籤（目錄）', 'Bookmarks', '檢視並編輯書籤階層', 'View and edit bookmark tree', () => pick(adv(), 'Bookmarks')),
  T('links', 'advanced', '🔗', '超連結管理', 'Links', '列出、新增與移除連結', 'List, add and remove links', () => pick(adv(), 'Links')),
  T('compare', 'advanced', '🆚', '頁面比較', 'Compare', '兩份 PDF 的文字與視覺差異', 'Text and visual diff of two PDFs', () => pick(adv(), 'Compare')),
  T('info', 'advanced', 'ℹ️', '文件資訊', 'Document info', '頁數、字型、影像、版本、時間', 'Pages, fonts, images, version, dates', () => pick(adv(), 'Info')),
  T('batch', 'advanced', '⚙️', '批次處理', 'Batch', '多檔套用同一操作並打包', 'Apply one operation to many files', () => pick(adv(), 'Batch')),
];
export const byId = (id: string) => TOOLS.find((t) => t.id === id);
export const CATS: Cat[] = ['edit', 'convert', 'markup', 'forms', 'security', 'advanced'];
