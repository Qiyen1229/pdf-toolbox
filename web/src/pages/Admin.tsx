import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Field, Spinner } from '../components/common';
import { TOOLS, byId } from '../tools/catalog';
import { downloadBytes } from '../lib/files';

type TabId = 'users' | 'roles' | 'features' | 'stats' | 'announcements' | 'settings' | 'audit';
const TABS: { id: TabId; label: string; perm: string }[] = [
  { id: 'stats', label: '用量統計', perm: 'stats.read' }, { id: 'users', label: '使用者', perm: 'users.read' }, { id: 'roles', label: '角色權限', perm: 'users.read' },
  { id: 'features', label: '功能開關', perm: 'features.manage' }, { id: 'announcements', label: '公告', perm: 'announcements.manage' },
  { id: 'settings', label: '系統設定', perm: 'settings.manage' }, { id: 'audit', label: '稽核日誌', perm: 'audit.read' },
];

function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let dead = false; setErr('');
    api<T>(path).then((d) => !dead && setData(d)).catch((e) => !dead && setErr(errorText(e)));
    return () => { dead = true; };
  }, [path, tick, ...deps]);
  return { data, err, reload: () => setTick((n) => n + 1) };
}

export default function Admin() {
  const { user } = useAuth();
  const tabs = TABS.filter((t) => user?.permissions.includes(t.perm));
  const [tab, setTab] = useState<TabId>('stats');
  useEffect(() => { if (tabs.length && !tabs.find((t) => t.id === tab)) setTab(tabs[0].id); }, [tabs.length]);
  if (!user) return <Alert kind="info">請先 <Link className="underline" to="/login">登入</Link>。</Alert>;
  if (!user.permissions.includes('admin.access')) return <Alert kind="error">沒有權限存取管理後台。</Alert>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">管理後台</h1>
      <div className="flex flex-wrap gap-1.5 border-b pb-2 dark:border-slate-700">{tabs.map((t) => <button key={t.id} onClick={() => setTab(t.id)} className={`btn btn-sm ${tab === t.id ? 'btn-primary' : ''}`}>{t.label}</button>)}</div>
      {tab === 'stats' && <Stats />}{tab === 'users' && <Users />}{tab === 'roles' && <Roles />}{tab === 'features' && <Features />}
      {tab === 'announcements' && <Announcements />}{tab === 'settings' && <SettingsTab />}{tab === 'audit' && <Audit />}
    </div>
  );
}

function Stats() {
  const { data, err } = useApi<{ daily: { day: string; n: number }[]; top: { tool_id: string; n: number }[]; sizes: { size_bucket: string; n: number }[]; users: { total: number; active: number }; last24h: number }>('/api/admin/stats');
  if (err) return <Alert kind="error">{err}</Alert>;
  if (!data) return <Spinner />;
  const max = Math.max(1, ...data.daily.map((d) => d.n));
  const maxTop = Math.max(1, ...data.top.map((d) => d.n));
  const maxSize = Math.max(1, ...data.sizes.map((d) => d.n));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card"><div className="hint">使用者</div><div className="text-2xl font-bold">{data.users.total}</div><div className="hint">啟用中 {data.users.active}</div></div>
        <div className="card"><div className="hint">近 24 小時操作</div><div className="text-2xl font-bold">{data.last24h}</div></div>
        <div className="card"><div className="hint">近 30 天操作</div><div className="text-2xl font-bold">{data.daily.reduce((s, d) => s + d.n, 0)}</div></div>
      </div>
      <div className="card"><div className="mb-2 text-sm font-semibold">每日操作數（近 30 天）</div>
        <div className="flex h-36 items-end gap-1">{data.daily.length ? data.daily.map((d) => <div key={d.day} title={`${d.day}：${d.n}`} className="flex-1 rounded-t bg-brand-500" style={{ height: `${(d.n / max) * 100}%`, minHeight: 2 }} />) : <span className="hint">尚無資料</span>}</div></div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-1.5"><div className="text-sm font-semibold">熱門功能</div>
          {data.top.map((t) => <div key={t.tool_id} className="flex items-center gap-2 text-sm"><span className="w-32 truncate">{byId(t.tool_id)?.name['zh-TW'] ?? t.tool_id}</span><div className="h-3 flex-1 rounded bg-slate-100 dark:bg-slate-800"><div className="h-3 rounded bg-brand-500" style={{ width: `${(t.n / maxTop) * 100}%` }} /></div><span className="w-10 text-right text-xs">{t.n}</span></div>)}
          {!data.top.length && <span className="hint">尚無資料</span>}</div>
        <div className="card space-y-1.5"><div className="text-sm font-semibold">檔案大小分布</div>
          {data.sizes.map((s) => <div key={s.size_bucket} className="flex items-center gap-2 text-sm"><span className="w-20">{s.size_bucket}</span><div className="h-3 flex-1 rounded bg-slate-100 dark:bg-slate-800"><div className="h-3 rounded bg-emerald-500" style={{ width: `${(s.n / maxSize) * 100}%` }} /></div><span className="w-10 text-right text-xs">{s.n}</span></div>)}
          {!data.sizes.length && <span className="hint">尚無資料</span>}</div>
      </div>
      <p className="hint">統計僅包含工具 ID 與檔案大小區間，不含檔名、內容或個人識別資訊。</p>
    </div>
  );
}

interface U { id: string; username?: string; email: string; display_name: string; role: string; is_active: boolean; totp_enabled: boolean; last_login_at: string | null; locked_until: string | null }
function Users() {
  const { user } = useAuth();
  const [q, setQ] = useState(''), [page, setPage] = useState(1);
  const { data, err, reload } = useApi<{ items: U[]; total: number; size: number }>(`/api/admin/users?q=${encodeURIComponent(q)}&page=${page}`);
  const [msg, setMsg] = useState(''), [e2, setE2] = useState('');
  const act = async (fn: () => Promise<any>, ok: string) => { setE2(''); setMsg(''); try { const r = await fn(); setMsg(ok + (r?.temporaryPassword ? `　臨時密碼（只顯示一次）：${r.temporaryPassword}` : '')); reload(); } catch (e) { setE2(errorText(e)); } };
  const canRole = user?.permissions.includes('users.role'), canWrite = user?.permissions.includes('users.write');
  return (
    <div className="space-y-3">
      <input className="input max-w-sm" placeholder="搜尋 Email、帳號或名稱…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      {msg && <Alert kind="ok"><span className="select-all break-all">{msg}</span></Alert>}{(err || e2) && <Alert kind="error">{err || e2}</Alert>}
      <div className="card overflow-x-auto !p-0">
        <table className="tbl"><thead><tr><th>使用者</th><th>角色</th><th>狀態</th><th>2FA</th><th>最後登入</th><th /></tr></thead>
          <tbody>{data?.items.map((u) => (
            <tr key={u.id}>
              <td>
                <div className="font-medium">{u.username ? `${u.username} (${u.email})` : u.email}</div>
                <div className="hint">{u.display_name}</div>
              </td>
              <td>{canRole && u.id !== user?.id ? <select className="input !min-h-8 !w-32 !py-0.5" value={u.role} onChange={(e) => void act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', json: { role: e.target.value } }), '角色已更新')}>
                {['super_admin', 'admin', 'viewer', 'user'].map((r) => <option key={r}>{r}</option>)}</select> : <span className="chip">{u.role}</span>}</td>
              <td>{u.is_active ? <span className="chip !bg-emerald-100 !text-emerald-800">啟用</span> : <span className="chip !bg-red-100 !text-red-800">停用</span>}{u.locked_until && new Date(u.locked_until) > new Date() ? <span className="chip ml-1 !bg-amber-100 !text-amber-800">鎖定</span> : null}</td>
              <td>{u.totp_enabled ? '✓' : '—'}</td><td className="text-xs">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}</td>
              <td className="whitespace-nowrap text-right">{canWrite && u.id !== user?.id && (
                <>
                  <button className="btn btn-sm" onClick={() => void act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', json: { isActive: !u.is_active } }), u.is_active ? '已停用' : '已啟用')}>{u.is_active ? '停用' : '啟用'}</button>{' '}
                  <button className="btn btn-sm" onClick={() => void act(() => api(`/api/admin/users/${u.id}/force-logout`, { method: 'POST' }), '已強制登出')}>登出</button>{' '}
                  <button className="btn btn-sm" onClick={() => { if (confirm(`重設 ${u.email} 的密碼？將產生一組臨時密碼。`)) void act(() => api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' }), '密碼已重設'); }}>重設密碼</button>{' '}
                  {u.locked_until && <button className="btn btn-sm" onClick={() => void act(() => api(`/api/admin/users/${u.id}/unlock`, { method: 'POST' }), '已解鎖')}>解鎖</button>}
                </>)}</td>
            </tr>))}</tbody></table>
      </div>
      {data && <div className="flex items-center gap-2 text-sm"><button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>第 {page} 頁 · 共 {data.total} 人<button className="btn btn-sm" disabled={page * data.size >= data.total} onClick={() => setPage(page + 1)}>›</button></div>}
    </div>
  );
}

function Roles() {
  const { user } = useAuth();
  const { data, err, reload } = useApi<{ roles: { name: string; description: string; permissions: string[] }[]; permissions: { key: string; description: string }[] }>('/api/admin/roles');
  const [msg, setMsg] = useState(''), [e2, setE2] = useState('');
  const can = user?.permissions.includes('roles.manage');
  if (err) return <Alert kind="error">{err}</Alert>;
  if (!data) return <Spinner />;
  const toggle = async (role: string, perm: string, on: boolean) => {
    const cur = data.roles.find((r) => r.name === role)!.permissions;
    const next = on ? [...cur, perm] : cur.filter((p) => p !== perm);
    try { await api(`/api/admin/roles/${role}/permissions`, { method: 'PUT', json: { permissions: next } }); setMsg(`已更新 ${role}`); reload(); } catch (e) { setE2(errorText(e)); }
  };
  return (
    <div className="space-y-3">
      {msg && <Alert kind="ok">{msg}</Alert>}{e2 && <Alert kind="error">{e2}</Alert>}
      <div className="card overflow-x-auto !p-0"><table className="tbl"><thead><tr><th>權限</th>{data.roles.map((r) => <th key={r.name}>{r.name}</th>)}</tr></thead>
        <tbody>{data.permissions.map((p) => (
          <tr key={p.key}><td><div className="font-mono text-xs">{p.key}</div><div className="hint">{p.description}</div></td>
            {data.roles.map((r) => <td key={r.name}><input type="checkbox" checked={r.permissions.includes(p.key)} disabled={!can || r.name === 'super_admin'} onChange={(e) => void toggle(r.name, p.key, e.target.checked)} /></td>)}</tr>))}</tbody></table></div>
      <p className="hint">super_admin 權限固定不可修改。變更會在使用者下次請求時立即生效（權限由伺服器每次查詢）。</p>
    </div>
  );
}

function Features() {
  const { data, err, reload } = useApi<{ items: { toolId: string; enabled: boolean; allowedRoles: string[] }[] }>('/api/admin/features');
  const [e2, setE2] = useState('');
  const ROLES = ['guest', 'user', 'viewer', 'admin', 'super_admin'];
  if (err) return <Alert kind="error">{err}</Alert>;
  if (!data) return <Spinner />;
  const save = async (toolId: string, enabled: boolean, allowedRoles: string[]) => { try { await api(`/api/admin/features/${toolId}`, { method: 'PUT', json: { enabled, allowedRoles } }); reload(); } catch (e) { setE2(errorText(e)); } };
  return (
    <div className="space-y-3">
      {e2 && <Alert kind="error">{e2}</Alert>}
      <div className="card overflow-x-auto !p-0"><table className="tbl"><thead><tr><th>工具</th><th>啟用</th><th>限定角色（全不選 = 所有人）</th></tr></thead>
        <tbody>{data.items.map((f) => (
          <tr key={f.toolId}><td>{TOOLS.find((t) => t.id === f.toolId)?.icon} {byId(f.toolId)?.name['zh-TW'] ?? f.toolId}</td>
            <td><input type="checkbox" checked={f.enabled} onChange={(e) => void save(f.toolId, e.target.checked, f.allowedRoles)} /></td>
            <td><div className="flex flex-wrap gap-2">{ROLES.map((r) => <label key={r} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.allowedRoles.includes(r)} onChange={(e) => void save(f.toolId, f.enabled, e.target.checked ? [...f.allowedRoles, r] : f.allowedRoles.filter((x) => x !== r))} />{r}</label>)}</div></td></tr>))}</tbody></table></div>
      <Alert kind="info">瀏覽器端工具的開關由前端依伺服器設定隱藏；因為處理在使用者裝置上進行，這屬於「管理政策」而非強制安全邊界。所有工具皆在本機處理，因此無法由伺服器強制阻擋。</Alert>
    </div>
  );
}

function Announcements() {
  const { data, err, reload } = useApi<{ items: { id: string; title: string; body: string; level: string; active: boolean }[] }>('/api/admin/announcements');
  const [f, setF] = useState({ title: '', body: '', level: 'info' });
  const [e2, setE2] = useState('');
  return (
    <div className="space-y-3">
      {(err || e2) && <Alert kind="error">{err || e2}</Alert>}
      <form className="card grid gap-3 sm:grid-cols-3" onSubmit={async (e) => { e.preventDefault(); try { await api('/api/admin/announcements', { method: 'POST', json: f }); setF({ title: '', body: '', level: 'info' }); reload(); } catch (x) { setE2(errorText(x)); } }}>
        <Field label="標題"><input className="input" required maxLength={120} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="內容"><input className="input" maxLength={2000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <Field label="等級"><select className="input" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}><option value="info">一般</option><option value="warning">警告</option><option value="critical">重要</option></select></Field>
        <div><button className="btn btn-primary">發布公告</button></div>
      </form>
      <div className="card !p-0"><table className="tbl"><tbody>{data?.items.map((a) => (
        <tr key={a.id}><td><b>{a.title}</b><div className="hint">{a.body}</div></td><td><span className="chip">{a.level}</span></td>
          <td className="text-right whitespace-nowrap"><button className="btn btn-sm" onClick={async () => { await api(`/api/admin/announcements/${a.id}`, { method: 'PATCH', json: { active: !a.active } }); reload(); }}>{a.active ? '下架' : '上架'}</button>{' '}
            <button className="btn btn-sm" onClick={async () => { if (confirm('刪除此公告？')) { await api(`/api/admin/announcements/${a.id}`, { method: 'DELETE' }); reload(); } }}>刪除</button></td></tr>))}</tbody></table></div>
    </div>
  );
}

function SettingsTab() {
  const { data, err, reload } = useApi<{ settings: Record<string, any> }>('/api/admin/settings');
  const { reload: reloadSite } = useAuth();
  const [e2, setE2] = useState(''), [msg, setMsg] = useState('');
  const [text, setText] = useState<string | null>(null);
  if (err) return <Alert kind="error">{err}</Alert>;
  if (!data) return <Spinner />;
  const s = data.settings;
  const set = async (patch: Record<string, unknown>) => { try { await api('/api/admin/settings', { method: 'PUT', json: patch }); setMsg('已儲存'); reload(); void reloadSite(); } catch (e) { setE2(errorText(e)); } };
  const Toggle = ({ k, label, hint }: { k: string; label: string; hint?: string }) => (
    <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={!!s[k]} onChange={(e) => void set({ [k]: e.target.checked })} /><span><span className="block text-sm font-medium">{label}</span>{hint && <span className="hint">{hint}</span>}</span></label>
  );
  return (
    <div className="card max-w-2xl space-y-4">
      {msg && <Alert kind="ok">{msg}</Alert>}{e2 && <Alert kind="error">{e2}</Alert>}
      <Toggle k="allow_registration" label="開放註冊" />
      <Toggle k="allow_guest_tools" label="允許未登入使用工具" hint="關閉後，所有人需登入才能使用任何工具" />
      <Field label="維護 / 站台訊息（顯示於頁首）"><div className="flex gap-2"><input className="input" value={text ?? s.maintenance_message ?? ''} onChange={(e) => setText(e.target.value)} maxLength={300} /><button className="btn" onClick={() => void set({ maintenance_message: text ?? s.maintenance_message ?? '' })}>儲存</button></div></Field>
    </div>
  );
}

function Audit() {
  const { user } = useAuth();
  const [page, setPage] = useState(1), [action, setAction] = useState('');
  const { data, err } = useApi<{ items: { id: number; actor_email: string | null; action: string; target: string | null; detail: any; ip: string | null; at: string }[]; total: number; size: number }>(`/api/admin/audit?page=${page}&action=${encodeURIComponent(action)}`);
  const [e2, setE2] = useState('');
  const exportCsv = useCallback(async () => {
    try { const b = await api<Blob>('/api/admin/audit/export', { blob: true }); downloadBytes(b, 'audit-log.csv', 'text/csv'); } catch (e) { setE2(errorText(e)); }
  }, []);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input !w-auto" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
          <option value="">全部事件</option><option value="auth.">認證</option><option value="admin.">管理操作</option><option value="auth.login_failed">登入失敗</option><option value="cli.">CLI</option></select>
        {user?.permissions.includes('audit.export') && <button className="btn btn-sm" onClick={() => void exportCsv()}>匯出 CSV</button>}
        <span className="hint">稽核日誌為 append-only：資料庫層禁止修改與刪除。</span>
      </div>
      {(err || e2) && <Alert kind="error">{err || e2}</Alert>}
      <div className="card overflow-x-auto !p-0"><table className="tbl"><thead><tr><th>時間</th><th>操作者</th><th>事件</th><th>目標</th><th>IP</th><th>細節</th></tr></thead>
        <tbody>{data?.items.map((a) => <tr key={a.id}><td className="whitespace-nowrap text-xs">{new Date(a.at).toLocaleString()}</td><td className="text-xs">{a.actor_email ?? '—'}</td><td className="font-mono text-xs">{a.action}</td><td className="text-xs">{a.target ?? ''}</td><td className="text-xs">{a.ip}</td><td className="max-w-xs truncate font-mono text-xs" title={JSON.stringify(a.detail)}>{Object.keys(a.detail ?? {}).length ? JSON.stringify(a.detail) : ''}</td></tr>)}</tbody></table></div>
      {data && <div className="flex items-center gap-2 text-sm"><button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>第 {page} 頁 · 共 {data.total} 筆<button className="btn btn-sm" disabled={page * data.size >= data.total} onClick={() => setPage(page + 1)}>›</button></div>}
    </div>
  );
}
