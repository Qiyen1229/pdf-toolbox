import type { Db } from '../db.js';
import { DEFAULT_SETTINGS } from '../db.js';

export async function getSettings(db: Db): Promise<Record<string, any>> {
  const { rows } = await db.query('select key, value from system_settings');
  const out: Record<string, any> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
