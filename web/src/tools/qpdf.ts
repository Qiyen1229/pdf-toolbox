import createModule from '@neslinesli93/qpdf-wasm';
import wasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';

export interface Permissions { print: boolean; copy: boolean; modify: boolean; annotate: boolean; fill: boolean; accessibility: boolean; assemble: boolean }
export const ALL_ALLOWED: Permissions = { print: true, copy: true, modify: true, annotate: true, fill: true, accessibility: true, assemble: true };

/** 每次呼叫建立獨立的 WASM 實例與記憶體檔案系統；完成後即丟棄，不殘留檔案內容。 */
async function run(input: Uint8Array, args: (inPath: string, outPath: string) => string[]): Promise<Uint8Array> {
  let stderr = '';
  const qpdf: any = await (createModule as any)({
    locateFile: () => wasmUrl,
    noInitialRun: true,
    print: () => {}, printErr: (s: string) => { stderr += s + '\n'; },
  });
  qpdf.FS.writeFile('/in.pdf', input);
  let code: number;
  try { code = qpdf.callMain(args('/in.pdf', '/out.pdf')); }
  catch (e: any) { code = typeof e?.status === 'number' ? e.status : 2; }
  // qpdf：0 成功、3 成功但有警告
  if (code !== 0 && code !== 3) {
    if (/invalid password/i.test(stderr)) throw new Error('密碼不正確');
    throw new Error('qpdf 處理失敗：' + (stderr.trim().split('\n').slice(-2).join(' ') || `code ${code}`));
  }
  const out = qpdf.FS.readFile('/out.pdf') as Uint8Array;
  try { qpdf.FS.unlink('/in.pdf'); qpdf.FS.unlink('/out.pdf'); } catch { /* ignore */ }
  return new Uint8Array(out);
}

/** AES-256（R6）加密；可設定開啟密碼與權限。 */
export function encryptPdf(bytes: Uint8Array, o: { userPassword: string; ownerPassword?: string; perms: Permissions }) {
  const owner = o.ownerPassword || crypto.randomUUID() + crypto.randomUUID();
  return run(bytes, (i, out) => [
    i, '--encrypt', o.userPassword, owner, '256',
    `--print=${o.perms.print ? 'full' : 'none'}`,
    `--extract=${o.perms.copy ? 'y' : 'n'}`,
    `--modify=${o.perms.modify ? 'all' : 'none'}`,
    `--annotate=${o.perms.annotate ? 'y' : 'n'}`,
    `--form=${o.perms.fill ? 'y' : 'n'}`,
    `--accessibility=${o.perms.accessibility ? 'y' : 'n'}`,
    `--assemble=${o.perms.assemble ? 'y' : 'n'}`,
    '--', out,
  ]);
}
export const decryptPdf = (bytes: Uint8Array, password: string) =>
  run(bytes, (i, out) => [`--password=${password}`, '--decrypt', i, out]);
