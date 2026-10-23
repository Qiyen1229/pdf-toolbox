export const ACCEPT_ALL = 'application/pdf,image/*,.docx,.xlsx,.pptx';
export const ACCEPT_PDF = 'application/pdf,.pdf';
export const ACCEPT_IMAGE = 'image/*,.tif,.tiff';
export const MAX_RECOMMENDED = 150 * 1024 * 1024;

export async function readBytes(f: File | Blob): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}
export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
export const stripExt = (n: string) => n.replace(/\.[^.]+$/, '');
export const isPdfBytes = (b: Uint8Array) => {
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024));
  return head.includes('%PDF-');
};
export function sniffImage(b: Uint8Array): 'png' | 'jpg' | 'webp' | 'gif' | 'tiff' | 'bmp' | null {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'webp';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return 'tiff';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}

const blobFor = (bytes: BlobPart, type: string) => new Blob([bytes], { type });

/** 下載後立即釋放 Blob URL（iOS 記憶體友善）。 */
export function downloadBytes(bytes: Uint8Array | Blob, filename: string, mime = 'application/pdf') {
  const blob = bytes instanceof Blob ? bytes : blobFor(bytes as BlobPart, mime);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export function canShareFiles(): boolean {
  try {
    const f = new File([new Uint8Array(1)], 'a.pdf', { type: 'application/pdf' });
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [f] });
  } catch { return false; }
}
/** Web Share API（iOS 可直接存到「檔案」或傳給其他 App）。回傳 false 表示使用者取消或不支援。 */
export async function shareBytes(bytes: Uint8Array | Blob, filename: string, mime = 'application/pdf'): Promise<boolean> {
  const file = new File([bytes instanceof Blob ? bytes : blobFor(bytes as BlobPart, mime)], filename, { type: mime });
  if (!canShareFiles() || !navigator.canShare({ files: [file] })) return false;
  try { await navigator.share({ files: [file], title: filename }); return true; }
  catch (e: any) { if (e?.name === 'AbortError') return false; throw e; }
}
export const mimeFor = (name: string) =>
  /\.pdf$/i.test(name) ? 'application/pdf' : /\.zip$/i.test(name) ? 'application/zip' : /\.png$/i.test(name) ? 'image/png'
  : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : /\.docx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  : /\.xlsx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  : /\.pptx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  : /\.html?$/i.test(name) ? 'text/html' : /\.md$/i.test(name) ? 'text/markdown' : /\.txt$/i.test(name) ? 'text/plain' : /\.tiff?$/i.test(name) ? 'image/tiff' : 'application/octet-stream';
