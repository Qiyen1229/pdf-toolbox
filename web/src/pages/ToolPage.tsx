import { Suspense } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { byId } from '../tools/catalog';
import { Alert, Spinner } from '../components/common';
import { t } from '../lib/i18n';

export default function ToolPage() {
  const { id = '' } = useParams();
  const { lang, toolEnabled, user, config, loading } = useAuth();
  const tool = byId(id);
  if (!tool) return <Alert kind="error">找不到這個工具。<Link className="underline" to="/">回到首頁</Link></Alert>;
  const Comp = tool.component;
  const guestBlocked = !loading && !user && config && !config.allowGuestTools;
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link to="/" className="text-xs text-slate-500 hover:underline">← {t('tools', lang)}</Link>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold"><span aria-hidden>{tool.icon}</span>{tool.name[lang]}</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{tool.desc[lang]}</p>
        <p className="mt-2 inline-block rounded-full border border-brand-500/40 bg-brand-500/10 px-2.5 py-1 text-xs text-brand-700 dark:text-brand-200">🔒 {t('privacy', lang)}</p>
      </div>
      {loading ? <div className="flex justify-center p-8"><Spinner /></div>
        : !toolEnabled(id) ? <Alert kind="warn">{t('disabled', lang)}</Alert>
        : guestBlocked ? <Alert kind="info">管理者設定為需登入才能使用工具。<Link className="underline" to="/login">前往登入</Link></Alert>
        : <Suspense fallback={<div className="flex justify-center p-8"><Spinner /></div>}><Comp id={id} /></Suspense>}
    </div>
  );
}
