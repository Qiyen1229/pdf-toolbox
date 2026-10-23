import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { CATS, TOOLS } from '../tools/catalog';
import { t } from '../lib/i18n';

export default function Home() {
  const { lang, toolEnabled, config } = useAuth();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('all');
  const list = useMemo(() => TOOLS.filter((x) => toolEnabled(x.id) && (cat === 'all' || x.cat === cat) &&
    (!q.trim() || (x.name['zh-TW'] + x.name.en + x.desc['zh-TW'] + x.desc.en).toLowerCase().includes(q.trim().toLowerCase()))), [q, cat, toolEnabled]);
  return (
    <div className="space-y-6">
      <section className="hero relative overflow-hidden rounded-2xl p-6 sm:p-10">
        <h1 className="gold-text text-3xl font-extrabold tracking-wide sm:text-4xl">{t('appName', lang)}</h1>
        <p className="mt-2 max-w-2xl text-sm text-brand-100/90 sm:text-base">合併、分割、壓縮、OCR、加密、塗黑…{lang === 'zh-TW' ? '大部分工具在你的瀏覽器內完成，檔案不會上傳。' : ' Most tools run entirely in your browser — files never leave your device.'}</p>
        <div className="mt-4 flex max-w-xl gap-2">
          <input className="input !border-transparent" placeholder={t('search', lang)} value={q} onChange={(e) => setQ(e.target.value)} aria-label="search" />
        </div>
      </section>
      <div className="flex flex-wrap gap-2">
        <button className={`btn btn-sm ${cat === 'all' ? 'btn-primary' : ''}`} onClick={() => setCat('all')}>{t('all', lang)}</button>
        {CATS.map((c) => <button key={c} className={`btn btn-sm ${cat === c ? 'btn-primary' : ''}`} onClick={() => setCat(c)}>{t(`cat.${c}`, lang)}</button>)}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((x, i) => (
          <Link key={x.id} to={`/tool/${x.id}`} style={{ animationDelay: `${Math.min(i, 24) * 35}ms` }} className="card card-hover group flex animate-rise gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-2xl ring-1 ring-brand-500/30 transition group-hover:scale-110 group-hover:rotate-3" aria-hidden>{x.icon}</div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-semibold">{x.name[lang]}</div>
              <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{x.desc[lang]}</div>
            </div>
          </Link>
        ))}
        {list.length === 0 && <div className="col-span-full py-12 text-center text-slate-500">沒有符合的工具</div>}
      </div>
    </div>
  );
}
