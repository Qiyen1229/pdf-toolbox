import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import crypto from 'node:crypto';
import type { Db } from '../db.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { alert } from '../lib/logger.js';
import { sendMail, mailEnabled } from '../lib/mailer.js';
import { sha256, randomToken, encrypt, decrypt, newTotpSecret, verifyTotp, otpauthUri } from '../lib/crypto.js';
import { signAccess, setAuthCookies, clearAuthCookies, requireAuth, PRIVILEGED_ROLES } from '../lib/session.js';
import { getSettings } from '../lib/settings.js';
import { authLimiter } from '../security.js';

const password = z.string().min(10, '密碼至少 10 個字元').max(128)
  .refine((s) => /[A-Za-z]/.test(s) && /\d/.test(s), '密碼需同時包含英文字母與數字');
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

// 用來讓「帳號不存在」與「密碼錯誤」耗時相近，避免帳號枚舉
let dummyHash: Promise<string> | null = null;
const getDummy = () => (dummyHash ??= hash('dummy-password-for-timing'));

export function authRouter(db: Db) {
  const r = Router();
  r.use(authLimiter);

  async function issueSession(req: Request, res: Response, user: { id: string; role: string; token_version: number }, family?: string) {
    const refresh = randomToken(48);
    await db.query(
      'insert into refresh_tokens(user_id, family, token_hash, expires_at, user_agent) values ($1,$2,$3, now() + ($4 || \' seconds\')::interval, $5)',
      [user.id, family ?? crypto.randomUUID(), sha256(refresh), String(config.refreshTtlSec), (req.get('user-agent') || '').slice(0, 200)],
    );
    setAuthCookies(res, signAccess(user), refresh);
  }

  async function publicUser(id: string) {
    const { rows } = await db.query(
      `select u.id, u.username, u.email, u.display_name, u.role, u.must_change_password, u.totp_enabled, u.email_verified,
              coalesce((select array_agg(permission) from role_permissions where role=u.role), '{}') as permissions,
              coalesce(p.language,'zh-TW') as language, coalesce(p.theme,'system') as theme, coalesce(p.output_quality,'balanced') as output_quality
         from users u left join user_preferences p on p.user_id=u.id where u.id=$1`, [id]);
    const u = rows[0];
    if (!u) return null;
    return {
      id: u.id, username: u.username || '', email: u.email, displayName: u.display_name, role: u.role,
      mustChangePassword: u.must_change_password, totpEnabled: u.totp_enabled, emailVerified: u.email_verified,
      permissions: u.permissions,
      setupRequired: false,
      preferences: { language: u.language, theme: u.theme, outputQuality: u.output_quality },
    };
  }

  r.post('/register', async (req, res) => {
    const s = await getSettings(db);
    if (!s.allow_registration) return res.status(403).json({ error: 'registration_disabled' });
    const p = z.object({
      email,
      username: z.string().trim().min(2).max(32).regex(/^[a-zA-Z0-9_-]+$/).optional(),
      password,
      displayName: z.string().trim().max(60).optional()
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input', issues: p.error.issues.map((i) => i.message) });
    const { email: em, username: un, password: pw, displayName } = p.data;
    const exists = await db.query(
      'select 1 from users where lower(email)=$1 or (username is not null and lower(username)=$2)',
      [em, (un || '').toLowerCase()]
    );
    if (exists.rowCount) return res.status(409).json({ error: 'email_or_username_taken' });
    const verified = !mailEnabled; // 未設定 SMTP 時無法驗證信箱，直接視為已驗證
    const { rows } = await db.query(
      'insert into users(email, username, display_name, password_hash, email_verified) values ($1,$2,$3,$4,$5) returning id',
      [em, un || null, displayName ?? '', await hash(pw), verified]);
    if (!verified) {
      const t = randomToken();
      await db.query(`insert into email_tokens(user_id, purpose, token_hash, expires_at) values ($1,'verify',$2, now() + interval '24 hours')`, [rows[0].id, sha256(t)]);
      await sendMail(em, '請驗證您的 PDF 工具箱信箱', `請點擊連結完成驗證（24 小時內有效）：\n${config.publicUrl}/#/verify-email?token=${t}`);
    }
    await audit(db, req, 'auth.register', { actorId: rows[0].id, actorEmail: em });
    res.status(201).json({ ok: true, verificationRequired: !verified });
  });

  r.post('/verify-email', async (req, res) => {
    const p = z.object({ token: z.string().min(10).max(200) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    const { rows } = await db.query(
      `update email_tokens set used_at=now() where token_hash=$1 and purpose='verify' and used_at is null and expires_at>now() returning user_id`, [sha256(p.data.token)]);
    if (!rows[0]) return res.status(400).json({ error: 'invalid_token' });
    await db.query('update users set email_verified=true where id=$1', [rows[0].user_id]);
    res.json({ ok: true });
  });

  r.post('/login', async (req, res) => {
    const p = z.object({
      email: z.string().trim().optional(),
      account: z.string().trim().optional(),
      password: z.string().min(1).max(128),
      totp: z.string().optional()
    }).refine((d) => Boolean((d.account && d.account.trim()) || (d.email && d.email.trim())), '請輸入帳號或電子郵件').safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    const identifier = (p.data.account || p.data.email || '').trim().toLowerCase();
    const { rows } = await db.query(
      'select * from users where lower(email)=$1 or (username is not null and lower(username)=$1)',
      [identifier]
    );
    const u = rows[0];
    const generic = () => res.status(401).json({ error: 'invalid_credentials' });
    if (!u) { await verify(await getDummy(), p.data.password).catch(() => false); return generic(); }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await audit(db, req, 'auth.login_locked', { actorId: u.id, actorEmail: u.email });
      return res.status(423).json({ error: 'account_locked', until: u.locked_until });
    }
    const fail = async (why: string) => {
      const n = u.failed_logins + 1;
      const lock = n >= config.maxFailedLogins;
      await db.query(
        `update users set failed_logins=$2, locked_until = case when $3 then now() + ($4 || ' minutes')::interval else locked_until end where id=$1`,
        [u.id, lock ? 0 : n, lock, String(config.lockMinutes)]);
      await audit(db, req, 'auth.login_failed', { actorId: u.id, actorEmail: u.email, detail: { why } });
      if (lock) { await audit(db, req, 'auth.account_locked', { actorId: u.id, actorEmail: u.email }); void alert('account_locked', { email: u.email, ip: req.ip }); }
      return generic();
    };
    const ok = await verify(u.password_hash, p.data.password).catch(() => false);
    if (!ok) return fail('password');
    if (!u.is_active) { await audit(db, req, 'auth.login_disabled', { actorId: u.id, actorEmail: u.email }); return generic(); }
    if (u.email_verified === false) return res.status(403).json({ error: 'email_not_verified' });
    if (u.totp_enabled) {
      if (!p.data.totp) return res.json({ needTotp: true });
      if (!verifyTotp(decrypt(u.totp_secret_enc), p.data.totp)) return fail('totp');
    }
    if (u.last_login_ip && u.last_login_ip !== req.ip && PRIVILEGED_ROLES.includes(u.role)) {
      void alert('admin_login_new_ip', { email: u.email, ip: req.ip, previous: u.last_login_ip });
      await audit(db, req, 'auth.login_new_ip', { actorId: u.id, actorEmail: u.email, detail: { previous: u.last_login_ip } });
    }
    await db.query('update users set failed_logins=0, locked_until=null, last_login_at=now(), last_login_ip=$2 where id=$1', [u.id, req.ip ?? null]);
    await issueSession(req, res, u);
    await audit(db, req, 'auth.login', { actorId: u.id, actorEmail: u.email });
    res.json({ user: await publicUser(u.id) });
  });

  r.post('/refresh', async (req, res) => {
    const tok = req.cookies?.refresh_token;
    if (!tok) return res.status(401).json({ error: 'unauthenticated' });
    // 單一原子語句：僅當未撤銷且未過期才撤銷並取得資料（旋轉）
    const { rows } = await db.query(
      `update refresh_tokens set revoked_at=now() where token_hash=$1 and revoked_at is null and expires_at>now() returning user_id, family`, [sha256(tok)]);
    if (!rows[0]) {
      // 已被撤銷的 token 又被使用 → 疑似被竊取，撤銷該 family
      const old = await db.query('select user_id, family from refresh_tokens where token_hash=$1', [sha256(tok)]);
      if (old.rows[0]) {
        await db.query('update refresh_tokens set revoked_at=now() where family=$1 and revoked_at is null', [old.rows[0].family]);
        void alert('refresh_reuse', { userId: old.rows[0].user_id, ip: req.ip });
      }
      clearAuthCookies(res);
      return res.status(401).json({ error: 'unauthenticated' });
    }
    const { rows: ur } = await db.query('select id, role, token_version, is_active from users where id=$1', [rows[0].user_id]);
    if (!ur[0] || !ur[0].is_active) { clearAuthCookies(res); return res.status(401).json({ error: 'unauthenticated' }); }
    await issueSession(req, res, ur[0], rows[0].family);
    res.json({ user: await publicUser(ur[0].id) });
  });

  r.post('/logout', async (req, res) => {
    const tok = req.cookies?.refresh_token;
    if (tok) await db.query('update refresh_tokens set revoked_at=now() where token_hash=$1 and revoked_at is null', [sha256(tok)]);
    if (req.user) await audit(db, req, 'auth.logout');
    clearAuthCookies(res);
    res.json({ ok: true });
  });

  r.get('/me', async (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: await publicUser(req.user.id) });
  });

  r.post('/forgot-password', async (req, res) => {
    const p = z.object({ email }).safeParse(req.body);
    if (p.success) {
      const { rows } = await db.query('select id, email from users where email=$1 and is_active', [p.data.email]);
      if (rows[0]) {
        const t = randomToken();
        await db.query(`insert into email_tokens(user_id, purpose, token_hash, expires_at) values ($1,'reset',$2, now() + interval '30 minutes')`, [rows[0].id, sha256(t)]);
        await sendMail(rows[0].email, 'PDF 工具箱：重設密碼', `請於 30 分鐘內點擊連結重設密碼：\n${config.publicUrl}/#/reset-password?token=${t}\n若非本人操作請忽略此信。`);
        await audit(db, req, 'auth.password_reset_requested', { actorId: rows[0].id, actorEmail: rows[0].email });
      }
    }
    res.json({ ok: true }); // 不論帳號是否存在皆回覆相同結果
  });

  r.post('/reset-password', async (req, res) => {
    const p = z.object({ token: z.string().min(10).max(200), newPassword: password }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input', issues: p.error.issues.map((i) => i.message) });
    const { rows } = await db.query(
      `update email_tokens set used_at=now() where token_hash=$1 and purpose='reset' and used_at is null and expires_at>now() returning user_id`, [sha256(p.data.token)]);
    if (!rows[0]) return res.status(400).json({ error: 'invalid_token' });
    await db.query(
      `update users set password_hash=$2, must_change_password=false, token_version=token_version+1, failed_logins=0, locked_until=null where id=$1`,
      [rows[0].user_id, await hash(p.data.newPassword)]);
    await db.query('update refresh_tokens set revoked_at=now() where user_id=$1 and revoked_at is null', [rows[0].user_id]);
    await audit(db, req, 'auth.password_reset', { actorId: rows[0].user_id });
    res.json({ ok: true });
  });

  r.post('/change-password', requireAuth, async (req, res) => {
    const p = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input', issues: p.error.issues.map((i) => i.message) });
    const { rows } = await db.query('select password_hash, role from users where id=$1', [req.user!.id]);
    if (!(await verify(rows[0].password_hash, p.data.currentPassword).catch(() => false))) return res.status(401).json({ error: 'invalid_credentials' });
    if (p.data.currentPassword === p.data.newPassword) return res.status(400).json({ error: 'invalid_input', issues: ['新密碼不可與舊密碼相同'] });
    const { rows: nu } = await db.query(
      'update users set password_hash=$2, must_change_password=false, token_version=token_version+1 where id=$1 returning id, role, token_version',
      [req.user!.id, await hash(p.data.newPassword)]);
    await db.query('update refresh_tokens set revoked_at=now() where user_id=$1 and revoked_at is null', [req.user!.id]);
    await issueSession(req, res, nu[0]); // 目前裝置維持登入，其他裝置全部登出
    await audit(db, req, 'auth.password_changed');
    res.json({ user: await publicUser(req.user!.id) });
  });

  // ---- TOTP ----
  r.post('/totp/setup', requireAuth, async (req, res) => {
    if (req.user!.totpEnabled) return res.status(409).json({ error: 'already_enabled' });
    const secret = newTotpSecret();
    await db.query('update users set totp_pending_enc=$2 where id=$1', [req.user!.id, encrypt(secret)]);
    res.json({ secret, otpauthUri: otpauthUri(req.user!.email, secret) });
  });
  r.post('/totp/enable', requireAuth, async (req, res) => {
    const p = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    const { rows } = await db.query('select totp_pending_enc from users where id=$1', [req.user!.id]);
    if (!rows[0]?.totp_pending_enc) return res.status(400).json({ error: 'no_pending_setup' });
    const secret = decrypt(rows[0].totp_pending_enc);
    if (!verifyTotp(secret, p.data.code)) return res.status(400).json({ error: 'invalid_code' });
    await db.query('update users set totp_enabled=true, totp_secret_enc=$2, totp_pending_enc=null where id=$1', [req.user!.id, encrypt(secret)]);
    await audit(db, req, 'auth.totp_enabled');
    res.json({ user: await publicUser(req.user!.id) });
  });
  r.post('/totp/disable', requireAuth, async (req, res) => {
    const p = z.object({ password: z.string().min(1).max(128), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_input' });
    const { rows } = await db.query('select password_hash, totp_secret_enc from users where id=$1', [req.user!.id]);
    if (!(await verify(rows[0].password_hash, p.data.password).catch(() => false)) || !rows[0].totp_secret_enc || !verifyTotp(decrypt(rows[0].totp_secret_enc), p.data.code))
      return res.status(401).json({ error: 'invalid_credentials' });
    await db.query('update users set totp_enabled=false, totp_secret_enc=null where id=$1', [req.user!.id]);
    await audit(db, req, 'auth.totp_disabled');
    res.json({ user: await publicUser(req.user!.id) });
  });

  return r;
}
