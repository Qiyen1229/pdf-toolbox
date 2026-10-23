/** 與 web/src/tools/catalog.ts 的 id 對應。功能開關與用量統計皆以此為準。 */
export const TOOL_IDS = [
  'merge', 'split', 'organize', 'crop', 'resize', 'compress', 'repair',
  'pdf-to-image', 'image-to-pdf', 'pdf-to-text', 'pdf-to-html', 'pdf-to-md', 'text-to-pdf',
  'pdf-to-docx', 'pdf-to-xlsx', 'pdf-to-pptx',
  'annotate', 'stamp', 'page-numbers', 'form-fill', 'form-create',
  'encrypt', 'decrypt', 'redact', 'signatures', 'metadata',
  'extract-text', 'search', 'ocr', 'bookmarks', 'links', 'compare', 'info', 'batch', 'viewer',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];
