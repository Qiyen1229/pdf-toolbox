export class ApiError extends Error {
  constructor(public status: number, public code: string, public body?: any) { super(code); }
}
const csrf = () => document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/)?.[1] ?? '';

async function raw(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  const method = (init.method || 'GET').toUpperCase();
  if (init.json !== undefined) { headers.set('content-type', 'application/json'); init.body = JSON.stringify(init.json); }
  if (method !== 'GET') headers.set('x-csrf-token', csrf());
  return fetch(path, { ...init, method, headers, credentials: 'same-origin' });
}

let refreshing: Promise<boolean> | null = null;
async function tryRefresh() {
  refreshing ??= raw('/api/auth/refresh', { method: 'POST' }).then((r) => r.ok).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = any>(path: string, opt: { method?: string; json?: unknown; form?: FormData; blob?: boolean } = {}): Promise<T> {
  const doFetch = () => raw(path, { method: opt.method, json: opt.json, body: opt.form });
  let res = await doFetch();
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    if (await tryRefresh()) res = await doFetch();
  }
  if (!res.ok) {
    let body: any = null;
    try { body = await res.json(); } catch { /* not json */ }
    throw new ApiError(res.status, body?.error ?? `http_${res.status}`, body);
  }
  if (opt.blob) return (await res.blob()) as any;
  return (res.status === 204 ? null : await res.json()) as T;
}

export const errorText = (e: unknown): string => {
  if (e instanceof ApiError) {
    const map: Record<string, string> = {
      invalid_credentials: '帳號或密碼錯誤', account_locked: '登入失敗次數過多，帳號已暫時鎖定 15 分鐘', email_taken: '此 Email 已被註冊',
      invalid_input: (e.body?.issues as string[] | undefined)?.join('；') || '輸入內容不符合規則', registration_disabled: '目前未開放註冊',
      email_not_verified: '請先到信箱完成驗證', too_many_requests: '請求過於頻繁，請稍後再試', forbidden: '沒有權限執行此操作',
      invalid_code: '驗證碼不正確', invalid_token: '連結無效或已過期',
      ip_not_allowed: '此 IP 不在管理後台白名單內', cannot_modify_self: '不能修改自己的帳號', last_super_admin: '至少需保留一位 super_admin',
      totp_required_for_role: '管理角色必須啟用雙重驗證', setup_required: '請先完成強制設定（變更密碼與雙重驗證）',
      unauthenticated: '請先登入', csrf: '安全驗證失敗，請重新整理頁面',
    };
    return map[e.code] ?? `伺服器錯誤（${e.code}）`;
  }
  return (e as any)?.message ?? String(e);
};

/** 用量統計：只送工具 id 與檔案大小，失敗不影響使用者流程。 */
export function reportUsage(tool: string, bytes?: number) {
  api('/api/usage', { method: 'POST', json: { tool, bytes } }).catch(() => {});
}
