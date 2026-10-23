function v4ToInt(ip: string): number | null {
  const m = ip.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return (((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0);
}
export function ipAllowed(ip: string | undefined, list: string[]): boolean {
  if (!list.length) return true;
  if (!ip) return false;
  const norm = ip.replace(/^::ffff:/, '');
  for (const entry of list) {
    if (!entry.includes('/')) { if (entry === norm || entry === ip) return true; continue; }
    const [base, bitsS] = entry.split('/');
    const b = v4ToInt(base), x = v4ToInt(norm), bits = +bitsS;
    if (b === null || x === null || !(bits >= 0 && bits <= 32)) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((b & mask) >>> 0) === ((x & mask) >>> 0)) return true;
  }
  return false;
}
