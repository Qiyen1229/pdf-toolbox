import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Field, Spinner } from '../components/common';

export function TotpSetup({ onDone }: { onDone: () => void }) {
  const [data, setData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState(''), [err, setErr] = useState('');
  useEffect(() => { api<{ secret: string; otpauthUri: string }>('/api/auth/totp/setup', { method: 'POST' }).then(async (d) => { setData(d); setQr(await QRCode.toDataURL(d.otpauthUri, { margin: 1, width: 200 })); }).catch((e) => setErr(errorText(e))); }, []);
  return (
    <div className="space-y-3">
      {!data && !err && <Spinner />}
      {data && (
        <>
          <p className="text-sm">用 Google Authenticator、1Password、Authy 等 App 掃描 QR Code，或手動輸入金鑰：</p>
          <div className="flex flex-wrap items-center gap-4">
            {qr && <img src={qr} alt="TOTP QR code" className="h-40 w-40 rounded border bg-white p-1" />}
            <code className="break-all rounded bg-slate-100 px-2 py-1 text-sm dark:bg-slate-800">{data.secret}</code>
          </div>
          <Field label="輸入 App 顯示的 6 位數驗證碼"><input className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
        </>
      )}
      {err && <Alert kind="error">{err}</Alert>}
      <button className="btn btn-primary" disabled={code.length !== 6} onClick={async () => { try { await api('/api/auth/totp/enable', { method: 'POST', json: { code } }); onDone(); } catch (e) { setErr(errorText(e)); } }}>啟用雙重驗證</button>
    </div>
  );
}

