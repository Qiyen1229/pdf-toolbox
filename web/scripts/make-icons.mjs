// 以純 Node 產生 PWA / iOS 圖示（不依賴影像函式庫）
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// maskable=true：全幅背景（安全區內繪製）；否則帶圓角
function icon(size, { maskable = false, rounded = true } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512;
  const set = (x, y, r, g, b, a = 255) => { const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
  const R = 96 * s;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // 背景：靛藍漸層
    const t = (x + y) / (2 * size);
    let [r, g, b] = [32 + (8 - 32) * t, 28 + (8 - 28) * t, 14 + (7 - 14) * t].map(Math.round);
    let a = 255;
    if (rounded && !maskable) { // 圓角
      const dx = Math.max(R - x, x - (size - R), 0), dy = Math.max(R - y, y - (size - R), 0);
      if (dx * dx + dy * dy > R * R) a = 0;
    }
    // 文件本體
    const k = maskable ? 0.78 : 1;
    const c = size / 2, X = (x - c) / s / k, Y = (y - c) / s / k;
    const inDoc = X > -118 && X < 118 && Y > -150 && Y < 150;
    const fold = X > 52 && Y < -84 && (X - 52) + (-84 - Y) > 66 + 0; // 折角裁掉
    if (inDoc && !(X + (-Y) > 118 + 150 - 66 && false)) {
      if (X + 0 > 52 && Y < -84 && X - 52 > (-84 - Y)) { /* 折角外側：保留背景 */ }
      else { [r, g, b] = [255, 255, 255]; }
    }
    // 折角三角
    if (X > 52 && X < 118 && Y > -150 && Y < -84 && X - 52 <= (-84 - Y) + 0 && (X - 52) >= (Y + 150) - 0 - 0) { [r, g, b] = [240, 217, 133]; }
    // 紅色標籤 + 文字線
    if (X > -118 && X < 118 && Y > 20 && Y < 92) [r, g, b] = [212, 175, 55];
    if (Y > -60 && Y < -40 && X > -78 && X < 78) [r, g, b] = [240, 217, 133];
    if (Y > -20 && Y < 0 && X > -78 && X < 40) [r, g, b] = [240, 217, 133];
    // 標籤上的 "PDF" 簡化為三個白色豎條
    if (Y > 38 && Y < 76 && ((X > -64 && X < -50) || (X > -4 && X < 10) || (X > 50 && X < 64))) [r, g, b] = [255, 255, 255];
    void fold;
    set(x, y, r, g, b, a);
  }
  return png(size, size, px);
}
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), icon(180, { rounded: false })); // iOS 自行套圓角
fs.writeFileSync(path.join(out, 'icon-192.png'), icon(192));
fs.writeFileSync(path.join(out, 'icon-512.png'), icon(512));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), icon(512, { maskable: true }));
fs.writeFileSync(path.join(out, 'favicon.svg'),
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0a0a09" stroke="#d4af37" stroke-width="3"/><path d="M18 10h20l10 10v34H18z" fill="#fff"/><path d="M38 10v10h10z" fill="#f0d985"/><rect x="18" y="36" width="30" height="10" fill="#d4af37"/></svg>`);
console.log('icons written');
