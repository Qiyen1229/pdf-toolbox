import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { applyTheme, type Theme } from '../lib/theme';
import { Alert, Field } from '../components/common';
import { byId } from '../tools/catalog';
import { TotpSetup } from './TotpSetup';

export default function Settings() {
  const { user, reload, lang, setLang } = useAuth();
  const [theme, setTheme] = useState<Theme>('system');
  const [quality, setQuality] = useState('balanced');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState(''), [err, setErr] = useState('');
  const [cur, setCur] = useState(''), [pw, setPw] = useState('');
  const [history, setHistory] = useState<{ tool: string; at: string }[]>([]);
  const [totpSetup, setTotpSetup] = useState(false);
  const [off, setOff] = useState({ password: '', code: '' });
  useEffect(() => {
    if (!user) return;
    setTheme(user.preferences.theme); setQuality(user.preferences.outputQuality); setName(user.displayName);
    api<{ items: { tool: string; at: string }[] }>('/api/me/history').then((r) => setHistory(r.items)).catch(() => {});
  }, [user]);
  if (!user) return <Alert kind="info">請先 <Link className="underline" to="/login">登入</Link>。</Alert>;
  const save = async () => {
    setErr(''); setMsg('');
    try { await api('/api/me/preferences', { method: 'PUT', json: { theme, outputQuality: quality, language: lang, displayName: name } }); applyTheme(theme); await reload(); setMsg('已儲存'); }
    catch (e) { setErr(errorText(e)); }
  };
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-bold">個人設定</h1>
      {msg && <Alert kind="ok">{msg}</Alert>}{err && <Alert kind="error">{err}</Alert>}
      <section className="card space-y-3">
        <h2 className="font-semibold">偏好</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="顯示名稱"><input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="語言"><select className="input" value={lang} onChange={(e) => setLang(e.target.value as any)}><option value="zh-TW">繁體中文</option><option value="en">English</option></select></Field>
          <Field label="主題"><select className="input" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}><option value="system">跟隨系統</option><option value="light">淺色</option><option value="dark">深色</option></select></Field>
          <Field label="預設輸出品質" hint="影響壓縮、轉圖片等工具的預設值"><select className="input" value={quality} onChange={(e) => setQuality(e.target.value)}><option value="high">高品質</option><option value="balanced">平衡</option><option value="small">小檔案</option></select></Field>
        </div>
        <button className="btn btn-primary" onClick={() => void save()}>儲存偏好</button>
      </section>
      <section className="card space-y-3">
        <h2 className="font-semibold">變更密碼</h2>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); setErr(''); setMsg(''); try { await api('/api/auth/change-password', { method: 'POST', json: { currentPassword: cur, newPassword: pw } }); setCur(''); setPw(''); setMsg('密碼已更新，其他裝置已登出'); } catch (x) { setErr(errorText(x)); } }}>
          <Field label="目前密碼"><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
          <Field label="新密碼"><input className="input" type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
          <div><button className="btn">更新密碼</button></div>
        </form>
      </section>
      <section className="card space-y-3">
        <h2 className="font-semibold">雙重驗證 (TOTP)</h2>
        {user.totpEnabled ? (
          <>
            <Alert kind="ok">已啟用</Alert>
            {(
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="密碼"><input className="input" type="password" value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} /></Field>
                <Field label="驗證碼"><input className="input" inputMode="numeric" maxLength={6} value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} /></Field>
                <div className="self-end"><button className="btn btn-danger" onClick={async () => { try { await api('/api/auth/totp/disable', { method: 'POST', json: off }); await reload(); setMsg('已停用'); } catch (e) { setErr(errorText(e)); } }}>停用</button></div>
              </div>
            )}
          </>
        ) : totpSetup ? <TotpSetup onDone={async () => { setTotpSetup(false); await reload(); setMsg('雙重驗證已啟用'); }} /> : <button className="btn" onClick={() => setTotpSetup(true)}>啟用雙重驗證</button>}
      </section>
      <section className="card space-y-2">
        <h2 className="font-semibold">使用紀錄</h2>
        <p className="hint">僅記錄操作類型與時間，不儲存檔名或檔案內容。顯示最近 100 筆。</p>
        {history.length === 0 ? <div className="hint">尚無紀錄</div> : (
          <div className="max-h-72 overflow-auto"><table className="tbl"><thead><tr><th>時間</th><th>工具</th></tr></thead>
            <tbody>{history.map((h, i) => <tr key={i}><td>{new Date(h.at).toLocaleString()}</td><td>{byId(h.tool)?.name['zh-TW'] ?? h.tool}</td></tr>)}</tbody></table></div>
        )}
      </section>
    </div>
  );
}
