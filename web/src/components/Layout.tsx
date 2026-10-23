import { useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { applyTheme, getTheme, type Theme } from '../lib/theme';

export function Layout({ children }: { children: ReactNode }) {
  const { user, config, lang, setLang, offline, setUser, reload } = useAuth();
  const nav = useNavigate();
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [menu, setMenu] = useState(false);
  const cycle = () => { const n: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark'; setTheme(n); applyTheme(n); };
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); setUser(null); await reload(); nav('/'); };
  const link = ({ isActive }: { isActive: boolean }) => `whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-100 text-brand-700 dark:bg-brand-600/20 dark:text-brand-200' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`;
  return (
    <div className="flex min-h-full flex-col">
      <header className="app-header sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-[#070706]/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2">
          <Link to="/" className="flex items-center gap-2 font-bold"><img src="/favicon.svg" alt="" className="h-7 w-7 transition-transform duration-500 hover:rotate-[360deg]" /><span className="gold-text hidden tracking-wide sm:inline">{t('appName', lang)}</span></Link>
          <nav className="order-last flex w-full items-center gap-1 overflow-x-auto sm:order-none sm:ml-2 sm:w-auto">
            <NavLink to="/" end className={link}>{t('tools', lang)}</NavLink>
            <NavLink to="/viewer" className={link}>{t('viewer', lang)}</NavLink>
            {user?.permissions.includes('admin.access') && !user.setupRequired && <NavLink to="/admin" className={link}>{t('admin', lang)}</NavLink>}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <button className="btn btn-ghost btn-sm" onClick={() => setLang(lang === 'zh-TW' ? 'en' : 'zh-TW')} aria-label="Language">{lang === 'zh-TW' ? 'EN' : '中'}</button>
            <button className="btn btn-ghost btn-sm" onClick={cycle} aria-label="Theme" title={`主題：${theme}`}>{theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '🖥️'}</button>
            {user ? (
              <div className="relative">
                <button className="btn btn-sm" onClick={() => setMenu((v) => !v)} aria-expanded={menu}><span className="inline-block max-w-28 truncate align-bottom">{user.displayName || user.email.split('@')[0]}</span> ▾</button>
                {menu && (
                  <div className="absolute right-0 mt-1 w-44 rounded-lg border bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900" onClick={() => setMenu(false)}>
                    <div className="truncate px-3 py-1 text-xs text-slate-500">{user.email}<br />{user.role}</div>
                    <Link to="/settings" className="block rounded px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">{t('settings', lang)}</Link>
                    <button className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => void logout()}>{t('logout', lang)}</button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <Link to="/login" className="btn btn-sm">{t('login', lang)}</Link>
                {config?.allowRegistration && <Link to="/register" className="btn btn-primary btn-sm hidden sm:inline-flex">{t('register', lang)}</Link>}
              </>
            )}
          </div>
        </div>
        {offline && <div className="bg-amber-500/15 px-4 py-1 text-center text-xs text-amber-700 dark:text-amber-200">{t('offline', lang)}</div>}
        {config?.maintenanceMessage && <div className="bg-brand-500/15 px-4 py-1 text-center text-xs text-brand-700 dark:text-brand-200">{config.maintenanceMessage}</div>}
        {config?.announcements.map((a) => (
          <div key={a.id} className={`px-4 py-1.5 text-center text-xs ${a.level === 'critical' ? 'bg-red-500/15 text-red-700 dark:text-red-200' : a.level === 'warning' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-200' : 'bg-brand-500/10 text-brand-700 dark:text-brand-100'}`}><b>{a.title}</b>{a.body ? `：${a.body}` : ''}</div>
        ))}
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
      <footer className="safe-bottom border-t border-slate-200 py-4 text-center text-xs text-slate-500 dark:border-slate-800">🔒 {t('privacy', lang)}</footer>
    </div>
  );
}
