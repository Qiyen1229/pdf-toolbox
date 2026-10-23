export type Lang = 'zh-TW' | 'en';
const dict: Record<string, { 'zh-TW': string; en: string }> = {
  appName: { 'zh-TW': 'PDF 工具箱', en: 'PDF Toolbox' },
  tools: { 'zh-TW': '工具', en: 'Tools' },
  viewer: { 'zh-TW': '檢視器', en: 'Viewer' },
  admin: { 'zh-TW': '管理後台', en: 'Admin' },
  login: { 'zh-TW': '登入', en: 'Sign in' },
  register: { 'zh-TW': '註冊', en: 'Sign up' },
  logout: { 'zh-TW': '登出', en: 'Sign out' },
  settings: { 'zh-TW': '個人設定', en: 'Settings' },
  search: { 'zh-TW': '搜尋工具…', en: 'Search tools…' },
  all: { 'zh-TW': '全部', en: 'All' },
  privacy: { 'zh-TW': '檔案只在你的裝置上處理，不會上傳', en: 'Files are processed on your device and never uploaded' },
  offline: { 'zh-TW': '離線中（已快取的工具仍可使用）', en: 'Offline (cached tools still work)' },
  disabled: { 'zh-TW': '此功能已被管理者停用', en: 'This tool has been disabled by the administrator' },
  'cat.edit': { 'zh-TW': '頁面編輯', en: 'Edit pages' },
  'cat.convert': { 'zh-TW': '格式轉換', en: 'Convert' },
  'cat.markup': { 'zh-TW': '註解與標記', en: 'Annotate & stamp' },
  'cat.forms': { 'zh-TW': '表單', en: 'Forms' },
  'cat.security': { 'zh-TW': '文件安全', en: 'Security' },
  'cat.advanced': { 'zh-TW': '進階與分析', en: 'Advanced' },
};
export const t = (k: string, lang: Lang) => dict[k]?.[lang] ?? dict[k]?.['zh-TW'] ?? k;
