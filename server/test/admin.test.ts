import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, client, makeUser, currentTotp, PW } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.db.close(); });

async function loginAdmin(email: string) {
  const c = client(ctx.app);
  const l = await c.post('/api/auth/login', { email, password: PW });
  expect(l.status).toBe(200);
  return { c, user: l.body.user };
}

describe('admin onboarding & RBAC', () => {
  it('admin can use admin API right after login; TOTP is optional and enforced once enabled', async () => {
    await makeUser(ctx.db, 'root@example.com', 'super_admin');
    const { c, user } = await loginAdmin('root@example.com');
    expect(user.setupRequired).toBe(false);
    expect((await c.get('/api/admin/users')).status).toBe(200);

    const s = await c.post('/api/auth/totp/setup');
    expect(s.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const { totpAt } = await import('../src/lib/crypto.js');
    const en = await c.post('/api/auth/totp/enable', { code: totpAt(s.body.secret, Math.floor(Date.now() / 30000)) });
    expect(en.status).toBe(200);
    const { rows } = await ctx.db.query('select totp_secret_enc from users where email=$1', ['root@example.com']);
    expect(rows[0].totp_secret_enc).toMatch(/^v1\./);
    expect(rows[0].totp_secret_enc).not.toContain(s.body.secret);

    const c2 = client(ctx.app);
    expect((await c2.post('/api/auth/login', { email: 'root@example.com', password: PW })).body.needTotp).toBe(true);
    expect((await c2.post('/api/auth/login', { email: 'root@example.com', password: PW, totp: '000000' })).status).toBe(401);
    expect((await c2.post('/api/auth/login', { email: 'root@example.com', password: PW, totp: await currentTotp(ctx.db, 'root@example.com') })).status).toBe(200);
  });

  it('regular users cannot reach /api/admin', async () => {
    await makeUser(ctx.db, 'plain@example.com');
    const { c } = await loginAdmin('plain@example.com');
    expect((await c.get('/api/admin/users')).status).toBe(403);
    expect((await c.get('/api/admin/audit')).status).toBe(403);
  });

  it('unauthenticated requests get 401', async () => {
    expect((await client(ctx.app).get('/api/admin/users')).status).toBe(401);
  });

  it('viewer can read but not write; admin cannot touch super_admin', async () => {
    // 準備已完成 TOTP 的帳號
    const mk = async (email: string, role: string) => {
      await makeUser(ctx.db, email, role);
      const { encrypt, newTotpSecret } = await import('../src/lib/crypto.js');
      await ctx.db.query('update users set totp_enabled=true, totp_secret_enc=$2 where email=$1', [email, encrypt(newTotpSecret())]);
    };
    await mk('viewer@example.com', 'viewer'); await mk('admin@example.com', 'admin');
    const login = async (email: string) => {
      const c = client(ctx.app);
      await c.post('/api/auth/login', { email, password: PW, totp: await currentTotp(ctx.db, email) });
      return c;
    };
    const v = await login('viewer@example.com');
    expect((await v.get('/api/admin/users')).status).toBe(200);
    const list = (await v.get('/api/admin/users?q=root')).body.items;
    const root = list.find((u: any) => u.email === 'root@example.com');
    expect((await v.post(`/api/admin/users/${root.id}/force-logout`)).status).toBe(403);

    const a = await login('admin@example.com');
    expect((await a.post(`/api/admin/users/${root.id}/force-logout`)).status).toBe(403);
    expect((await a.patch(`/api/admin/users/${root.id}`, { isActive: false })).status).toBe(403);
    const plain = (await a.get('/api/admin/users?q=plain')).body.items[0];
    expect((await a.patch(`/api/admin/users/${plain.id}`, { role: 'admin' })).status).toBe(403); // admin 無 users.role
    expect((await a.patch(`/api/admin/users/${plain.id}`, { isActive: false })).status).toBe(200);
    // 被停用者無法登入
    expect((await client(ctx.app).post('/api/auth/login', { email: 'plain@example.com', password: PW })).status).toBe(401);
  });

  it('audit log is append-only and exportable', async () => {
    await expect(ctx.db.query('delete from audit_logs')).rejects.toThrow();
    await expect(ctx.db.query(`update audit_logs set action='x'`)).rejects.toThrow();
    const n = await ctx.db.query('select count(*)::int as n from audit_logs');
    expect(n.rows[0].n).toBeGreaterThan(3);
  });

  it('feature flags change /api/config', async () => {
    await ctx.db.query(`insert into feature_flags(tool_id, enabled) values ('ocr', false) on conflict (tool_id) do update set enabled=false`);
    const r = await client(ctx.app).get('/api/config');
    expect(r.body.tools.ocr).toBe(false);
    expect(r.body.tools.merge).toBe(true);
  });
});

