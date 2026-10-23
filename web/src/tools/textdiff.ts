export interface DiffPart { type: 'same' | 'add' | 'del'; text: string }
/** 以詞為單位的 LCS 差異（CJK 以字為單位）。超大輸入會退化為整段比較以保護效能。 */
export function diffText(a: string, b: string): DiffPart[] {
  const tok = (s: string) => s.match(/[㐀-鿿぀-ヿ]|[^\s㐀-鿿぀-ヿ]+|\s+/g) ?? [];
  const A = tok(a), B = tok(b);
  if (A.length * B.length > 4_000_000) return a === b ? [{ type: 'same', text: a }] : [{ type: 'del', text: a }, { type: 'add', text: b }];
  const n = A.length, m = B.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (type: DiffPart['type'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text; else out.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', A[i++]);
    else push('add', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return out;
}
