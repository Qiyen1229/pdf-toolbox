import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useAuth, type User } from '../lib/auth';
import { Alert, Field, Spinner } from '../components/common';

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return <div className="mx-auto max-w-sm"><div className="card space-y-4"><h1 className="text-xl font-bold">{title}</h1>{children}</div></div>;
}

export function Login() {
  const { reload, config } = useAuth();
  const nav = useNavigate();
  const [account, setAccount] = useState(''), [password, setPassword] = useState(''), [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api<{ needTotp?: boolean; user?: User }>('/api/auth/login', {
        method: 'POST',
        json: { account: account.trim(), email: account.trim(), password, totp: needTotp ? totp : undefined },
      });
      if (r.needTotp) { setNeedTotp(true); return; }
      await reload();
      nav('/');
    } catch (e: any) { setErr(errorText(e)); if (needTotp) setTotp(''); }
    finally { setBusy(false); }
  };
  return (
    <Shell title="登入">
      <form className="space-y-3" onSubmit={submit}>
        {!needTotp ? (
          <>
            <Field label="使用者帳號或電子郵件">
              <input
                className="input"
                type="text"
                autoComplete="username"
                required
                placeholder="請輸入帳號或 Email"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              />
            </Field>
            <Field label="密碼">
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <Field label="雙重驗證碼" hint="開啟 Google Authenticator 等 App，輸入 6 位數"><input className="input text-center text-2xl tracking-[.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} /></Field>
        )}
        {err && <Alert kind="error">{err}</Alert>}
        <button className="btn btn-primary w-full" disabled={busy}>{busy ? <Spinner /> : null} {needTotp ? '驗證並登入' : '登入'}</button>
      </form>
      <div className="flex justify-between text-sm"><Link className="underline" to="/forgot-password">忘記密碼？</Link>{config?.allowRegistration && <Link className="underline" to="/register">建立帳號</Link>}</div>
    </Shell>
  );
}

export function Register() {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState('');
  const [err, setErr] = useState(''), [done, setDone] = useState<null | boolean>(null), [busy, setBusy] = useState(false);
  const { config } = useAuth();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api<{ verificationRequired: boolean }>('/api/auth/register', { method: 'POST', json: { email, password, displayName: name } }); setDone(r.verificationRequired); }
    catch (e: any) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  if (config && !config.allowRegistration) return <Shell title="註冊"><Alert kind="info">目前未開放註冊。</Alert></Shell>;
  if (done !== null) return <Shell title="註冊完成"><Alert kind="ok">{done ? '驗證信已寄出，請到信箱點擊連結完成驗證後再登入。' : '帳號已建立，現在可以登入。'}</Alert><Link className="btn btn-primary w-full" to="/login">前往登入</Link></Shell>;
  return (
    <Shell title="建立帳號">
      <form className="space-y-3" onSubmit={submit}>
        <Field label="顯示名稱（選填）"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
        <Field label="Email"><input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="密碼" hint="至少 10 個字元，需包含英文字母與數字"><input className="input" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {err && <Alert kind="error">{err}</Alert>}
        <button className="btn btn-primary w-full" disabled={busy}>{busy ? <Spinner /> : null} 註冊</button>
      </form>
      <p className="hint">帳號僅用於偏好設定與使用紀錄（只記錄工具名稱與時間），不會儲存你的檔案。</p>
    </Shell>
  );
}

export function Forgot() {
  const [email, setEmail] = useState(''), [sent, setSent] = useState(false), [busy, setBusy] = useState(false);
  return (
    <Shell title="忘記密碼">
      {sent ? <Alert kind="ok">若此 Email 已註冊，我們已寄出重設連結（30 分鐘內有效）。</Alert> : (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await api('/api/auth/forgot-password', { method: 'POST', json: { email } }).catch(() => {}); setSent(true); setBusy(false); }}>
          <Field label="註冊 Email"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <button className="btn btn-primary w-full" disabled={busy}>寄送重設連結</button>
        </form>
      )}
    </Shell>
  );
}

export function ResetPassword() {
  const [sp] = useSearchParams();
  const [pw, setPw] = useState(''), [err, setErr] = useState(''), [ok, setOk] = useState(false);
  return (
    <Shell title="重設密碼">
      {ok ? <><Alert kind="ok">密碼已更新，請重新登入。</Alert><Link className="btn btn-primary w-full" to="/login">登入</Link></> : (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await api('/api/auth/reset-password', { method: 'POST', json: { token: sp.get('token'), newPassword: pw } }); setOk(true); } catch (x) { setErr(errorText(x)); } }}>
          <Field label="新密碼" hint="至少 10 個字元，需包含英文字母與數字"><input className="input" type="password" autoComplete="new-password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          {err && <Alert kind="error">{err}</Alert>}
          <button className="btn btn-primary w-full">更新密碼</button>
        </form>
      )}
    </Shell>
  );
}

export function VerifyEmail() {
  const [sp] = useSearchParams();
  const [state, setState] = useState<'wait' | 'ok' | 'err'>('wait');
  useEffect(() => { api('/api/auth/verify-email', { method: 'POST', json: { token: sp.get('token') } }).then(() => setState('ok')).catch(() => setState('err')); }, [sp]);
  return <Shell title="信箱驗證">{state === 'wait' ? <Spinner /> : state === 'ok' ? <><Alert kind="ok">信箱已驗證。</Alert><Link className="btn btn-primary w-full" to="/login">登入</Link></> : <Alert kind="error">連結無效或已過期。</Alert>}</Shell>;
}
