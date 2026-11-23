// 主题控制：跟随系统深浅色（支持手动覆盖），仅通过 data-theme 属性切换，不写内联 style。

const STORAGE_THEME = 'class-relay-theme';
const BG_LIGHT = '#F2F7F5';
const BG_DARK = '#141A19';

export function loadTheme(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(STORAGE_THEME);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch { /* ignore */ }
  return 'system';
}

export function saveTheme(mode, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE_THEME, mode); } catch { /* ignore */ }
}

export function applyTheme(mode = loadTheme(), root = document.documentElement) {
  const sysDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = mode === 'dark' || (mode === 'system' && sysDark);
  root.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? BG_DARK : BG_LIGHT);
  return dark;
}
