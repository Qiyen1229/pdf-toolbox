import { Router } from 'express';
import { z } from 'zod';
import { hash } from '@node-rs/argon2';
import type { Db } from '../db.js';
import { PERMISSIONS } from '../db.js';
import { audit } from '../lib/audit.js';
import { randomToken } from '../lib/crypto.js';
import { requirePerm } from '../lib/session.js';
import { TOOL_IDS } from '../lib/tools.js';
import { getSettings } from '../lib/settings.js';

const ROLES = ['super_admin', 'admin', 'viewer', 'user'] as const;
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防 CSV 公式注入
  return `"${s.replace(/"/g, '""')}"`;
};

export function adminRouter(db: Db) {
  const r = Router();

  // ---------- Users ----------
  r.get('/users', requirePerm('users.read'), async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const page = Math.max(1, Number(req.query.page) || 1), size = 25;
    const where = q ? `where email ilike $1 or display_name ilike $1 or username ilike $1` : '';
    const params = q ? [`%${q.replace(/[%_\\]/g, '\\$&')}%`] : [];
    const total = await db.query(`select count(*)::int as n from users ${where}`, params);
    const { rows } = await db.query(
      `select id, username, email, display_name, role, is_active, totp_enabled, email_verified, last_login_at, created_at, locked_until
         from users ${where} order by created_at desc limit ${size} offset ${(page - 1) * size}`, params);
    res.json({ items: rows, total: total.rows[0].n, page, size });
  });

  async function target(req: any, res: any) {
    const { rows } = await db.query('select id, email, role from users where id=$1', [String(req.params.id)]);
    if (!rows[0]) { res.status(404).json({ error: 'not_found' }); return null; }
    const t = rows[0];
    // admin 不得動 super_admin；任何人不得動自己的停用/角色
    if (t.role === 'super_admin' && req.user.role !== 'super_admin') { res.status(403).json({ error: 'forbidden' }); return null; }
    return t;
  }

  r.patch('/users/:id', requirePerm('users.write'), async (req, res) => {
    const p = z.object({ isActive: z.boolean().optional(), role: z.enum(ROLES).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    const t = await target(req, res); if (!t) return;
    const self = t.id === req.user!.id;
    if (p.data.isActive !== undefined) {
      if (self) return res.status(400).json({ error: 'cannot_modify_self' });
      await db.query('update users set is_active=$2, token_version=token_version+1 where id=$1', [t.id, p.data.isActive]);
      if (!p.data.isActive) await db.query('update refresh_tokens set revoked_at=now() where user_id=$1 and revoked_at is null', [t.id]);
      await audit(db, req, p.data.isActive ? 'admin.user_enabled' : 'admin.user_disabled', { target: t.email });
    }
    if (p.data.role !== undefined && p.data.role !== t.role) {
      if (!req.user!.permissions.includes('users.role')) return res.status(403).json({ error: 'forbidden' });
      if (self) return res.status(400).json({ error: 'cannot_modify_self' });
      if (p.data.role === 'super_admin' && req.user!.role !== 'super_admin') return res.status(403).json({ error: 'forbidden' });
      if (t.role === 'super_admin') {
        const n = await db.query(`select count(*)::int as n from users where role='super_admin' and is_active`);
        if (n.rows[0].n <= 1) return res.status(400).json({ error: 'last_super_admin' });
      }
      await db.query('update users set role=$2, token_version=token_version+1 where id=$1', [t.id, p.data.role]);
      await audit(db, req, 'admin.role_changed', { target: t.email, detail: { from: t.role, to: p.data.role } });
    }
    res.json({ ok: true });
  });

  r.post('/users/:id/reset-password', requirePerm('users.write'), async (req, res) => {
    const t = await target(req, res); if (!t) return;
    // 產生一次性暫時密碼，只回傳這一次；使用者下次登入必須變更
    const temp = randomToken(12) + 'a1';
    await db.query('update users set password_hash=$2, must_change_password=true, token_version=token_version+1, failed_logins=0, locked_until=null where id=$1', [t.id, await hash(temp)]);
    await db.query('update refresh_tokens set revoked_at=now() where user_id=$1 and revoked_at is null', [t.id]);
    await audit(db, req, 'admin.password_reset', { target: t.email });
    res.json({ temporaryPassword: temp });
  });

  r.post('/users/:id/force-logout', requirePerm('users.write'), async (req, res) => {
    const t = await target(req, res); if (!t) return;
    await db.query('update users set token_version=token_version+1 where id=$1', [t.id]);
    await db.query('update refresh_tokens set revoked_at=now() where user_id=$1 and revoked_at is null', [t.id]);
    await audit(db, req, 'admin.force_logout', { target: t.email });
    res.json({ ok: true });
  });

  r.post('/users/:id/unlock', requirePerm('users.write'), async (req, res) => {
    const t = await target(req, res); if (!t) return;
    await db.query('update users set failed_logins=0, locked_until=null where id=$1', [t.id]);
    await audit(db, req, 'admin.unlock', { target: t.email });
    res.json({ ok: true });
  });

  // ---------- Roles / RBAC ----------
  r.get('/roles', requirePerm('users.read'), async (_req, res) => {
    const roles = await db.query('select name, description from roles order by name');
    const rp = await db.query('select role, permission from role_permissions');
    res.json({
      roles: roles.rows.map((x: any) => ({ ...x, permissions: rp.rows.filter((p: any) => p.role === x.name).map((p: any) => p.permission) })),
      permissions: Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
    });
  });
  r.put('/roles/:name/permissions', requirePerm('roles.manage'), async (req, res) => {
    const p = z.object({ permissions: z.array(z.string()).max(50) }).safeParse(req.body);
    const name = String(req.params.name);
    if (!p.success || !(ROLES as readonly string[]).includes(name)) return res.status(400).json({ error: 'invalid_input' });
    if (name === 'super_admin') return res.status(400).json({ error: 'super_admin_immutable' });
    const perms = p.data.permissions.filter((k) => k in PERMISSIONS);
    await db.query('delete from role_permissions where role=$1', [name]);
    for (const k of perms) await db.query('insert into role_permissions(role, permission) values ($1,$2)', [name, k]);
    await audit(db, req, 'admin.role_permissions_changed', { target: name, detail: { permissions: perms } });
    res.json({ ok: true });
  });

  // ---------- Feature flags ----------
  r.get('/features', requirePerm('features.manage'), async (_req, res) => {
    const { rows } = await db.query('select tool_id, enabled, allowed_roles from feature_flags');
    const m = new Map(rows.map((x: any) => [x.tool_id, x]));
    res.json({ items: TOOL_IDS.map((id) => ({ toolId: id, enabled: (m.get(id) as any)?.enabled ?? true, allowedRoles: (m.get(id) as any)?.allowed_roles ?? [] })) });
  });
  r.put('/features/:toolId', requirePerm('features.manage'), async (req, res) => {
    const p = z.object({ enabled: z.boolean(), allowedRoles: z.array(z.enum([...ROLES, 'guest'])).default([]) }).safeParse(req.body);
    if (!p.success || !(TOOL_IDS as readonly string[]).includes(String(req.params.toolId))) return res.status(400).json({ error: 'invalid_input' });
    await db.query(
      `insert into feature_flags(tool_id, enabled, allowed_roles) values ($1,$2,$3) on conflict (tool_id) do update set enabled=$2, allowed_roles=$3`,
      [String(req.params.toolId), p.data.enabled, p.data.allowedRoles]);
    await audit(db, req, 'admin.feature_changed', { target: String(req.params.toolId), detail: p.data });
    res.json({ ok: true });
  });

  // ---------- Stats（僅彙總數據） ----------
  r.get('/stats', requirePerm('stats.read'), async (_req, res) => {
    const [daily, top, sizes, users, today] = await Promise.all([
      db.query(`select to_char(date_trunc('day', at), 'YYYY-MM-DD') as day, count(*)::int as n from usage_events where at > now() - interval '30 days' group by 1 order by 1`),
      db.query(`select tool_id, count(*)::int as n from usage_events where at > now() - interval '30 days' group by 1 order by n desc limit 10`),
      db.query(`select size_bucket, count(*)::int as n from usage_events where at > now() - interval '30 days' group by 1 order by 1`),
      db.query(`select count(*)::int as total, count(*) filter (where is_active)::int as active from users`),
      db.query(`select count(*)::int as n from usage_events where at > now() - interval '1 day'`),
    ]);
    res.json({ daily: daily.rows, top: top.rows, sizes: sizes.rows, users: users.rows[0], last24h: today.rows[0].n });
  });

  // ---------- Announcements ----------
  r.get('/announcements', requirePerm('announcements.manage'), async (_req, res) => {
    const { rows } = await db.query('select id, title, body, level, active, created_at from announcements order by created_at desc limit 100');
    res.json({ items: rows });
  });
  r.post('/announcements', requirePerm('announcements.manage'), async (req, res) => {
    const p = z.object({ title: z.string().trim().min(1).max(120), body: z.string().max(2000).default(''), level: z.enum(['info', 'warning', 'critical']).default('info') }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    const { rows } = await db.query('insert into announcements(title, body, level) values ($1,$2,$3) returning id', [p.data.title, p.data.body, p.data.level]);
    await audit(db, req, 'admin.announcement_created', { target: rows[0].id, detail: { title: p.data.title } });
    res.status(201).json({ id: rows[0].id });
  });
  r.patch('/announcements/:id', requirePerm('announcements.manage'), async (req, res) => {
    const p = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    await db.query('update announcements set active=$2 where id=$1', [String(req.params.id), p.data.active]);
    await audit(db, req, 'admin.announcement_toggled', { target: String(req.params.id), detail: p.data });
    res.json({ ok: true });
  });
  r.delete('/announcements/:id', requirePerm('announcements.manage'), async (req, res) => {
    await db.query('delete from announcements where id=$1', [String(req.params.id)]);
    await audit(db, req, 'admin.announcement_deleted', { target: String(req.params.id) });
    res.json({ ok: true });
  });

  // ---------- Settings ----------
  r.get('/settings', requirePerm('settings.manage'), async (_req, res) => res.json({ settings: await getSettings(db) }));
  r.put('/settings', requirePerm('settings.manage'), async (req, res) => {
    const p = z.object({
      allow_registration: z.boolean().optional(), allow_guest_tools: z.boolean().optional(),
      maintenance_message: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    for (const [k, v] of Object.entries(p.data)) {
      await db.query('insert into system_settings(key, value) values ($1,$2::jsonb) on conflict (key) do update set value=$2::jsonb', [k, JSON.stringify(v)]);
    }
    await audit(db, req, 'admin.settings_changed', { detail: p.data });
    res.json({ ok: true });
  });

  // ---------- Audit log ----------
  r.get('/audit', requirePerm('audit.read'), async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1), size = 50;
    const action = String(req.query.action ?? '').slice(0, 60);
    const where = action ? 'where action like $1' : '';
    const params = action ? [action.replace(/[%_\\]/g, '\\$&') + '%'] : [];
    const total = await db.query(`select count(*)::int as n from audit_logs ${where}`, params);
    const { rows } = await db.query(
      `select id, actor_email, action, target, detail, ip, at from audit_logs ${where} order by id desc limit ${size} offset ${(page - 1) * size}`, params);
    res.json({ items: rows, total: total.rows[0].n, page, size });
  });
  r.get('/audit/export', requirePerm('audit.export'), async (req, res) => {
    const { rows } = await db.query('select id, at, actor_email, action, target, detail, ip from audit_logs order by id desc limit 50000');
    await audit(db, req, 'admin.audit_exported', { detail: { rows: rows.length } });
    const head = ['id', 'at', 'actor_email', 'action', 'target', 'detail', 'ip'];
    const csv = [head.join(','), ...rows.map((x: any) => head.map((h) => csvCell(h === 'at' ? new Date(x.at).toISOString() : x[h])).join(','))].join('\r\n');
    res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit-log.csv"', 'cache-control': 'no-store' });
    res.send('﻿' + csv);
  });

  return r;
}
