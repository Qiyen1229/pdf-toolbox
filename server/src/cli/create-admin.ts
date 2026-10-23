/**
 * 管理者初始化：npm run admin:create -- --email admin@example.com
 * 密碼取自環境變數 ADMIN_PASSWORD；未提供則隨機產生並只顯示一次。
 * 建立後TOTP 為選用，可於個人設定啟用。
 * 對既有帳號重複執行 = 重設密碼 + 清除 TOTP（遺失驗證裝置時的救援程序）。
 */
import { hash } from '@node-rs/argon2';
import { openDb, migrate } from '../db.js';
import { randomToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = (arg('email') || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const username = (arg('username') || process.env.ADMIN_USERNAME || '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('用法: npm run admin:create -- --email admin@example.com [--username qiyen] [--role super_admin]'); process.exit(1); }
const role = arg('role') || 'super_admin';
const name = arg('name') || username || '';
if (!['super_admin', 'admin'].includes(role)) { console.error('role 必須為 super_admin 或 admin'); process.exit(1); }

const db = await openDb();
await migrate(db);
const generated = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD || randomToken(12) + 'aA1';
const ph = await hash(password);
const ex = await db.query('select id from users where lower(email)=$1 or (username is not null and lower(username)=$2)', [email, username || '']);
if (ex.rowCount) {
  await db.query(`update users set username=$2, email=$3, password_hash=$4, role=$5, display_name=$6, must_change_password=false, is_active=true, email_verified=true, token_version=token_version+1, failed_logins=0, locked_until=null, totp_enabled=false, totp_secret_enc=null, totp_pending_enc=null where id=$1`, [ex.rows[0].id, username || null, email, ph, role, name]);
} else {
  await db.query(`insert into users(username, email, password_hash, role, display_name, must_change_password, email_verified) values ($1,$2,$3,$4,$5,false,true)`, [username || null, email, ph, role, name]);
}
await audit(db, null, 'cli.admin_created', { actorEmail: 'cli', target: email, detail: { role, username } });
console.log(`\n管理者已${ex.rowCount ? '重設' : '建立'}：${username ? `${username} <${email}>` : email}（${role}）`);
if (generated) console.log(`一次性密碼：${password}\n（首次登入須變更密碼並設定 TOTP，此密碼不會再次顯示）`);
await db.close();
