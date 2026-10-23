// 把 OCR 引擎與語言資料複製到 public/vendor/（自行託管，不依賴外部 CDN → 隱私 + 離線）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'public', 'vendor');
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const copy = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };

const tess = pkgDir('tesseract.js');
copy(path.join(tess, 'dist', 'worker.min.js'), path.join(out, 'tesseract', 'worker.min.js'));
const core = pkgDir('tesseract.js-core');
for (const f of fs.readdirSync(core)) {
  if (/^tesseract-core.*lstm\.wasm\.js$/.test(f)) copy(path.join(core, f), path.join(out, 'tesseract', 'core', f));
}
for (const lang of ['eng', 'chi_tra', 'chi_sim', 'jpn']) {
  const d = pkgDir(`@tesseract.js-data/${lang}`);
  const f = path.join(d, '4.0.0_best_int', `${lang}.traineddata.gz`);
  copy(f, path.join(out, 'tessdata', `${lang}.traineddata.gz`));
}
console.log('[assets] vendor files ready in public/vendor');

// pdf.js：CJK 非內嵌字型所需的 CMap 與標準字型
const pdfjs = pkgDir('pdfjs-dist');
for (const sub of ['cmaps', 'standard_fonts']) {
  const dir = path.join(pdfjs, sub);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) copy(path.join(dir, f), path.join(out, sub, f));
}
console.log('[assets] pdf.js cmaps/fonts ready');
