import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setup, client, makeUser, PW } from './helpers.js';
import { totpAt, verifyTotp, newTotpSecret, encrypt, decrypt } from '../src/lib/crypto.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.db.close(); });

describe('crypto', () => {
  it('TOTP matches RFC 6238 vector (SHA1, T=59 → 94287082 → last 6 = 287082)', () => {
    // secret "12345678901234567890" in base32
    expect(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', Math.floor(59 / 30))).toBe('287082');
  });
  it('verifyTotp accepts current window, rejects wrong', () => {
    const s = newTotpSecret();
    expect(verifyTotp(s, totpAt(s, Math.floor(Date.now() / 30000)))).toBe(true);
    expect(verifyTotp(s, '12345')).toBe(false);
  });
  it('AES-256-GCM roundtrip and tamper detection', () => {
    const c = encrypt('secret-value');
    expect(c).not.toContain('secret-value');
    expect(decrypt(c)).toBe('secret-value');
    const bad = c.slice(0, -2) + (c.endsWith('A') ? 'B' : 'A') + c.slice(-1);
    expect(() => decrypt(bad)).toThrow();
  });
});

describe('registration & login', () => {
  it('rejects weak passwords', async () => {
    const c = client(ctx.app);
    const r = await c.post('/api/auth/register', { email: 'weak@example.com', password: 'short' });
    expect(r.status).toBe(400);
  });
  it('registers, logs in, reads /me, logs out', async () => {
    const c = client(ctx.app);
    expect((await c.post('/api/auth/register', { email: 'Alice@Example.com', password: PW })).status).toBe(201);
    expect((await c.post('/api/auth/register', { email: 'alice@example.com', password: PW })).status).toBe(409);
    const l = await c.post('/api/auth/login', { email: 'alice@example.com', password: PW });
    expect(l.status).toBe(200);
    expect(l.body.user.role).toBe('user');
    expect(JSON.stringify(l.body)).not.toMatch(/argon|password_hash|totp_secret/i);
    const cookies = ([] as string[]).concat(l.headers['set-cookie']);
    const access = cookies.find((x) => x.startsWith('access_token='))!;
    expect(access).toMatch(/HttpOnly/i); expect(access).toMatch(/SameSite=Strict/i);
    expect((await c.get('/api/auth/me')).body.user.email).toBe('alice@example.com');
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).body.user).toBeNull();
  });
  it('locks account after 5 failures', async () => {
    await makeUser(ctx.db, 'lock@example.com');
    const c = client(ctx.app);
    for (let i = 0; i < 5; i++) expect((await c.post('/api/auth/login', { email: 'lock@example.com', password: 'wrong-password-1' })).status).toBe(401);
    const r = await c.post('/api/auth/login', { email: 'lock@example.com', password: PW });
    expect(r.status).toBe(423);
  });
  it('same error for unknown user', async () => {
    const r = await client(ctx.app).post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password-1' });
    expect(r.status).toBe(401); expect(r.body.error).toBe('invalid_credentials');
  });
  it('allows login by username or email', async () => {
    const c = client(ctx.app);
    expect((await c.post('/api/auth/register', { email: 'qiyen_test@example.com', username: 'qiyen_test', password: PW })).status).toBe(201);
    // login by username
    const l1 = await c.post('/api/auth/login', { account: 'qiyen_test', password: PW });
    expect(l1.status).toBe(200);
    expect(l1.body.user.username).toBe('qiyen_test');
    await c.post('/api/auth/logout');

    // login by email
    const l2 = await c.post('/api/auth/login', { account: 'qiyen_test@example.com', password: PW });
    expect(l2.status).toBe(200);
    await c.post('/api/auth/logout');
  });
  it('rotates refresh tokens and detects reuse', async () => {
    await makeUser(ctx.db, 'rot@example.com');
    const c = client(ctx.app);
    const l = await c.post('/api/auth/login', { email: 'rot@example.com', password: PW });
    const oldRefresh = ([] as string[]).concat(l.headers['set-cookie']).find((x) => x.startsWith('refresh_token='))!.split(';')[0];
    expect((await c.post('/api/auth/refresh')).status).toBe(200);
    const replay = await request(ctx.app).post('/api/auth/refresh').set('Cookie', oldRefresh);
    expect(replay.status).toBe(401);
    // family revoked → the rotated token no longer works either
    expect((await c.post('/api/auth/refresh')).status).toBe(401);
  });
});

describe('CSRF', () => {
  it('rejects mutating request with cookie but no token', async () => {
    await makeUser(ctx.db, 'csrf@example.com');
    const c = client(ctx.app);
    await c.post('/api/auth/login', { email: 'csrf@example.com', password: PW });
    const r = await c.agent.put('/api/me/preferences').send({ theme: 'dark' }); // no header
    expect(r.status).toBe(403);
    expect((await c.put('/api/me/preferences', { theme: 'dark' })).status).toBe(200);
  });
});

describe('password storage', () => {
  it('uses Argon2id', async () => {
    await makeUser(ctx.db, 'hash@example.com');
    const { rows } = await ctx.db.query('select password_hash from users where email=$1', ['hash@example.com']);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });
});
