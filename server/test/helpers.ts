import request from 'supertest';
import { hash } from '@node-rs/argon2';
import { openDb, migrate, type Db } from '../src/db.js';
import { createApp } from '../src/app.js';
import { totpAt, decrypt } from '../src/lib/crypto.js';

export async function setup() {
  const db = await openDb({ memory: true });
  await migrate(db);
  const app = createApp(db);
  return { db, app };
}
export const PW = 'Correct-horse-9battery';

/** 帶 cookie jar 與 CSRF header 的 client */
export function client(app: any) {
  const agent = request.agent(app);
  let csrf = '';
  const wrap = (m: 'get' | 'post' | 'put' | 'patch' | 'delete') => async (url: string, body?: any) => {
    const r = agent[m](url);
    if (m !== 'get') r.set('x-csrf-token', csrf);
    const res = await (body !== undefined ? r.send(body) : r);
    const sc = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    for (const c of sc) { const x = c.match(/^csrf=([^;]+)/); if (x) csrf = x[1]; }
    return res;
  };
  return { csrf: () => csrf, get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete'), agent };
}

export async function makeUser(db: Db, email: string, role = 'user', opts: { must?: boolean } = {}) {
  await db.query('insert into users(email, password_hash, role, must_change_password, email_verified) values ($1,$2,$3,$4,true)',
    [email, await hash(PW), role, !!opts.must]);
}
export async function currentTotp(db: Db, email: string) {
  const { rows } = await db.query('select totp_secret_enc from users where email=$1', [email]);
  return totpAt(decrypt(rows[0].totp_secret_enc), Math.floor(Date.now() / 30000));
}
