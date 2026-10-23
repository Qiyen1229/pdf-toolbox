import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { TOOL_IDS } from '../lib/tools.js';
import { getSettings } from '../lib/settings.js';
import { requireReady, requireAuth } from '../lib/session.js';
import { usageLimiter } from '../security.js';
import { mailEnabled } from '../lib/mailer.js';

const bucket = (bytes: number) => (bytes < 1 << 20 ? '<1MB' : bytes < 10 << 20 ? '1-10MB' : bytes < 50 << 20 ? '10-50MB' : '>50MB');

export function publicRouter(db: Db) {
  const r = Router();

  /** 前端啟動時取得：目前角色可用的工具、公告、站台設定。 */
  r.get('/config', async (req, res) => {
    const role = req.user?.role ?? 'guest';
    const [flags, ann, s] = await Promise.all([
      db.query('select tool_id, enabled, allowed_roles from feature_flags'),
      db.query(`select id, title, body, level from announcements where active order by created_at desc limit 5`),
      getSettings(db),
    ]);
    const map = new Map(flags.rows.map((f: any) => [f.tool_id, f]));
    const tools: Record<string, boolean> = {};
    for (const id of TOOL_IDS) {
      const f: any = map.get(id);
      let on = !f || f.enabled;
      if (on && f?.allowed_roles?.length) on = f.allowed_roles.includes(role);
      if (on && !req.user && !s.allow_guest_tools) on = false;
      tools[id] = on;
    }
    res.json({
      tools, announcements: ann.rows,
      allowRegistration: !!s.allow_registration, allowGuestTools: !!s.allow_guest_tools,
      maintenanceMessage: s.maintenance_message || '',
      mailEnabled,
    });
  });

  /** 用量統計：只記錄工具 id 與檔案大小區間，不含檔名或內容。 */
  r.post('/usage', usageLimiter, async (req, res) => {
    const p = z.object({ tool: z.enum(TOOL_IDS), bytes: z.number().int().min(0).max(2 ** 40).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    await db.query('insert into usage_events(user_id, tool_id, size_bucket) values ($1,$2,$3)', [req.user?.id ?? null, p.data.tool, p.data.bytes === undefined ? 'unknown' : bucket(p.data.bytes)]);
    res.json({ ok: true });
  });

  r.get('/me/history', requireAuth, requireReady, async (req, res) => {
    const { rows } = await db.query('select tool_id as tool, at from usage_events where user_id=$1 order by at desc limit 100', [req.user!.id]);
    res.json({ items: rows });
  });

  r.put('/me/preferences', requireAuth, requireReady, async (req, res) => {
    const p = z.object({
      language: z.enum(['zh-TW', 'zh-CN', 'en', 'ja']).optional(),
      theme: z.enum(['system', 'light', 'dark']).optional(),
      outputQuality: z.enum(['high', 'balanced', 'small']).optional(),
      displayName: z.string().trim().max(60).optional(),
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    const d = p.data;
    await db.query(
      `insert into user_preferences(user_id, language, theme, output_quality) values ($1, coalesce($2,'zh-TW'), coalesce($3,'system'), coalesce($4,'balanced'))
       on conflict (user_id) do update set language=coalesce($2, user_preferences.language), theme=coalesce($3, user_preferences.theme), output_quality=coalesce($4, user_preferences.output_quality)`,
      [req.user!.id, d.language ?? null, d.theme ?? null, d.outputQuality ?? null]);
    if (d.displayName !== undefined) await db.query('update users set display_name=$2 where id=$1', [req.user!.id, d.displayName]);
    res.json({ ok: true });
  });

  return r;
}
