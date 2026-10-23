import path from 'node:path';
import { hash } from '@node-rs/argon2';
import { config } from './config.js';
import { log } from './lib/logger.js';

export interface Db {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

export async function openDb(opts: { memory?: boolean } = {}): Promise<Db> {
  if (config.databaseUrl && !opts.memory) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    return {
      kind: 'postgres',
      async query(text, params) { const r = await pool.query(text, params as any[]); return { rows: r.rows, rowCount: r.rowCount ?? 0 }; },
      close: () => pool.end(),
    };
  }
  // 開發 / 單機預覽：PGlite（WASM 版 PostgreSQL 17），語法與 PostgreSQL 相同
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(opts.memory ? undefined : path.join(config.dataDir, 'pgdata'));
  await db.waitReady;
  log.info({ memory: !!opts.memory }, 'using embedded PGlite (set DATABASE_URL for PostgreSQL)');
  return {
    kind: 'pglite',
    async query(text, params) { const r = await db.query(text, params as any[]); return { rows: r.rows as any[], rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) }; },
    close: () => db.close(),
  };
}

const SCHEMA = `
create table if not exists roles (name text primary key, description text not null default '');
create table if not exists permissions (key text primary key, description text not null default '');
create table if not exists role_permissions (
  role text not null references roles(name) on delete cascade,
  permission text not null references permissions(key) on delete cascade,
  primary key (role, permission)
);
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text unique,
  email text not null unique,
  display_name text not null default '',
  password_hash text not null,
  role text not null references roles(name) default 'user',
  is_active boolean not null default true,
  email_verified boolean not null default false,
  must_change_password boolean not null default false,
  totp_secret_enc text,
  totp_pending_enc text,
  totp_enabled boolean not null default false,
  failed_logins int not null default 0,
  locked_until timestamptz,
  token_version int not null default 0,
  last_login_at timestamptz,
  last_login_ip text,
  created_at timestamptz not null default now()
);
create table if not exists refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  family uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists refresh_tokens_user on refresh_tokens(user_id);
create table if not exists email_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('reset','verify')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz
);
create table if not exists user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  language text not null default 'zh-TW',
  theme text not null default 'system',
  output_quality text not null default 'balanced'
);
create table if not exists feature_flags (
  tool_id text primary key,
  enabled boolean not null default true,
  allowed_roles text[] not null default '{}'
);
create table if not exists usage_events (
  id bigserial primary key,
  user_id uuid,
  tool_id text not null,
  size_bucket text not null default 'unknown',
  at timestamptz not null default now()
);
create index if not exists usage_events_at on usage_events(at);
create index if not exists usage_events_user on usage_events(user_id, at desc);
create table if not exists audit_logs (
  id bigserial primary key,
  actor_id uuid,
  actor_email text,
  action text not null,
  target text,
  detail jsonb not null default '{}',
  ip text,
  at timestamptz not null default now()
);
create index if not exists audit_logs_at on audit_logs(at desc);
create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  level text not null default 'info',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists system_settings (key text primary key, value jsonb not null);

create or replace function audit_logs_immutable() returns trigger as $$
begin
  raise exception 'audit_logs is append-only';
end;
$$ language plpgsql;
drop trigger if exists audit_logs_no_update on audit_logs;
create trigger audit_logs_no_update before update or delete on audit_logs for each row execute function audit_logs_immutable();
drop trigger if exists audit_logs_no_truncate on audit_logs;
create trigger audit_logs_no_truncate before truncate on audit_logs for each statement execute function audit_logs_immutable();
`;

export const PERMISSIONS: Record<string, string> = {
  'admin.access': '進入管理後台',
  'users.read': '檢視使用者',
  'users.write': '停用/啟用、重設密碼、強制登出',
  'users.role': '變更使用者角色',
  'roles.manage': '編輯角色權限',
  'features.manage': '管理功能開關',
  'stats.read': '檢視用量統計',
  'announcements.manage': '管理公告',
  'settings.manage': '修改系統設定',
  'audit.read': '檢視稽核日誌',
  'audit.export': '匯出稽核日誌',
};
const ROLE_DEFS: Record<string, { desc: string; perms: string[] }> = {
  super_admin: { desc: '超級管理員', perms: Object.keys(PERMISSIONS) },
  admin: { desc: '管理員', perms: ['admin.access', 'users.read', 'users.write', 'features.manage', 'stats.read', 'announcements.manage', 'audit.read'] },
  viewer: { desc: '唯讀檢視者', perms: ['admin.access', 'users.read', 'stats.read', 'audit.read'] },
  user: { desc: '一般使用者', perms: [] },
};
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  allow_registration: true,
  allow_guest_tools: true,
  maintenance_message: '',
};

export async function migrate(db: Db) {
  for (const stmt of SCHEMA.split(/;\s*\n(?=\s*(?:create|drop|alter))/i)) {
    if (stmt.trim()) await db.query(stmt.trim().replace(/;\s*$/, ''));
  }
  // 相容舊資料庫：確保 users 表具備 username 欄位
  await db.query('alter table users add column if not exists username text unique');

  for (const [k, d] of Object.entries(PERMISSIONS)) {
    await db.query('insert into permissions(key, description) values ($1,$2) on conflict (key) do update set description = excluded.description', [k, d]);
  }
  for (const [role, def] of Object.entries(ROLE_DEFS)) {
    const existed = await db.query('select 1 from roles where name=$1', [role]);
    await db.query('insert into roles(name, description) values ($1,$2) on conflict (name) do nothing', [role, def.desc]);
    if (!existed.rowCount) { // 僅首次植入預設權限，之後保留管理者的調整
      for (const p of def.perms) await db.query('insert into role_permissions(role, permission) values ($1,$2) on conflict do nothing', [role, p]);
    }
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await db.query('insert into system_settings(key, value) values ($1,$2::jsonb) on conflict (key) do nothing', [k, JSON.stringify(v)]);
  }
}

/**
 * 伺服器啟動時自動檢查並初始化預設管理者帳號
 */
export async function seedAdmin(db: Db) {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  if (!email || !password) return;

  const ph = await hash(password);
  const ex = await db.query(
    'select id from users where lower(email)=$1 or (username is not null and lower(username)=$2)',
    [email, username || '']
  );
  if (ex.rowCount) {
    await db.query(
      `update users set username=$2, email=$3, password_hash=$4, role='super_admin', is_active=true, email_verified=true, token_version=token_version+1 where id=$1`,
      [ex.rows[0].id, username || null, email, ph]
    );
    log.info({ email, username }, '管理者帳號已同步/更新 (seedAdmin)');
  } else {
    await db.query(
      `insert into users(username, email, password_hash, role, display_name, must_change_password, email_verified)
       values ($1, $2, $3, 'super_admin', $4, false, true)`,
      [username || null, email, ph, username || 'Admin']
    );
    log.info({ email, username }, '管理者帳號已建立 (seedAdmin)');
  }
}

