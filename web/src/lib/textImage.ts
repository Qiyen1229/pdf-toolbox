import type { TextImageRenderer } from '../tools/ops/stamp';

/** 以 Canvas 把文字畫成 PNG：可使用系統內建的 CJK 字型，不需另外打包字型檔。 */
export const renderTextImage: TextImageRenderer = async (text, px, color, family, bold) => {
  const font = `${bold ? '700 ' : ''}${px}px ${family ? `"${family}",` : ''}"Noto Sans TC","PingFang TC","Microsoft JhengHei","Noto Sans CJK TC","Hiragino Sans","Yu Gothic",sans-serif`;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 4;
  const h = Math.ceil(px * 1.35);
  const c = document.createElement('canvas');
  c.width = Math.max(w, 1); c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.font = font; ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  ctx.fillText(text, 2, h / 2);
  const blob: Blob = await new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('文字轉圖失敗'))), 'image/png'));
  return { png: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
};
