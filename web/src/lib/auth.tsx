import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { applyTheme, getTheme, type Theme } from './theme';
import type { Lang } from './i18n';

export interface User {
  id: string; username?: string; email: string; displayName: string; role: string; mustChangePassword: boolean; totpEnabled: boolean;
  setupRequired: boolean; permissions: string[]; emailVerified: boolean;
  preferences: { language: Lang | string; theme: Theme; outputQuality: 'high' | 'balanced' | 'small' };
}
export interface SiteConfig {
  tools: Record<string, boolean>; announcements: { id: string; title: string; body: string; level: string }[];
  allowRegistration: boolean; allowGuestTools: boolean; maintenanceMessage: string; mailEnabled: boolean;
}
interface Ctx {
  user: User | null; config: SiteConfig | null; loading: boolean; lang: Lang; offline: boolean;
  setLang: (l: Lang) => void; reload: () => Promise<void>; setUser: (u: User | null) => void;
  toolEnabled: (id: string) => boolean; outputQuality: 'high' | 'balanced' | 'small';
}
const AuthCtx = createContext<Ctx>(null as any);
export const useAuth = () => useContext(AuthCtx);

const FALLBACK: SiteConfig = { tools: {}, announcements: [], allowRegistration: false, allowGuestTools: true, maintenanceMessage: '', mailEnabled: false };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [lang, setLangState] = useState<Lang>(() => {
    try { return (localStorage.getItem('lang') as Lang) || (navigator.language.startsWith('zh') ? 'zh-TW' : 'en'); } catch { return 'zh-TW'; }
  });

  const reload = useCallback(async () => {
    try {
      const me = await api<{ user: User | null }>('/api/auth/me');
      setUser(me.user);
      if (me.user) { applyTheme(me.user.preferences.theme); if (me.user.preferences.language === 'en' || me.user.preferences.language === 'zh-TW') setLangState(me.user.preferences.language as Lang); }
      setConfig(await api<SiteConfig>('/api/config'));
    } catch { setConfig((c) => c ?? FALLBACK); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    applyTheme(getTheme());
    void reload();
    const on = () => setOffline(false), off = () => setOffline(true);
    addEventListener('online', on); addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, [reload]);

  const value = useMemo<Ctx>(() => ({
    user, config, loading, lang, offline, reload, setUser,
    setLang: (l) => { setLangState(l); try { localStorage.setItem('lang', l); } catch { /* ignore */ } document.documentElement.lang = l; },
    toolEnabled: (id) => (config?.tools[id] ?? true),
    outputQuality: user?.preferences.outputQuality ?? 'balanced',
  }), [user, config, loading, lang, offline, reload]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
