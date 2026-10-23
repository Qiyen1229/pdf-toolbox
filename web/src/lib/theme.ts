export type Theme = 'system' | 'light' | 'dark';
export function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  try { localStorage.setItem('theme', t); } catch { /* private mode */ }
}
export const getTheme = (): Theme => { try { return (localStorage.getItem('theme') as Theme) || 'dark'; } catch { return 'dark'; } };
