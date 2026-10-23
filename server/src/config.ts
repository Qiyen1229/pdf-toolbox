import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v && Number.isFinite(+v) ? Math.trunc(+v) : d);

const dataDir = path.resolve(env.DATA_DIR || (isProd ? '/tmp/data' : './data'));
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {
  // 在唯讀容器環境下忽略建立失敗，避免程式崩潰
}

/** 機密：生產環境必須由環境變數提供；開發環境才會在 data/ 下自動產生（該目錄已 gitignore）。 */
function secret(name: string, bytes: number): string {
  const v = env[name];
  if (isProd && v && /CHANGE_ME/i.test(v)) {
    console.error(`[config] ${name} 仍是範本預設值，請產生隨機機密：openssl rand -base64 48`);
    process.exit(1);
  }
  if (v && v.length >= 32) return v;
  if (isProd) {
    console.error(`[config] 缺少必要環境變數 ${name}（至少 32 字元）。請參考 .env.example`);
    process.exit(1);
  }
  const file = path.join(dataDir, 'dev-secrets.json');
  let store: Record<string, string> = {};
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
  if (!store[name]) {
    store[name] = crypto.randomBytes(bytes).toString('base64url');
    fs.writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
  }
  return store[name];
}

export const config = {
  isProd,
  env: env.NODE_ENV || 'development',
  port: int(env.PORT, 9133),
  dataDir,
  databaseUrl: env.DATABASE_URL || '',
  jwtSecret: secret('JWT_SECRET', 48),
  encKey: crypto.createHash('sha256').update(secret('APP_ENC_KEY', 48)).digest(), // 32 bytes → AES-256
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  forceHttps: bool(env.FORCE_HTTPS, false),
  trustProxy: env.TRUST_PROXY || (isProd ? '1' : 'false'),
  publicUrl: env.PUBLIC_URL || `http://localhost:${int(env.PORT, 9133)}`,
  accessTtlSec: 15 * 60,
  refreshTtlSec: int(env.REFRESH_TTL_DAYS, 7) * 86400,
  maxFailedLogins: 5,
  lockMinutes: 15,
  adminIpAllowlist: (env.ADMIN_IP_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'PDF 工具箱 <no-reply@localhost>',
  },
  alertWebhook: env.ALERT_WEBHOOK_URL || '',
  webDist: path.resolve(env.WEB_DIST || path.join(process.cwd(), '..', 'web', 'dist')),
};
