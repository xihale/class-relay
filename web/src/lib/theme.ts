import { computed, signal, type ReadonlySignal } from '@preact/signals';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_THEME = 'class-relay-theme';
const BG_LIGHT = '#F6F8FB';
const BG_DARK = '#0B1017';

function readSavedTheme(): ThemeMode {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_THEME);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // ignore storage errors
  }
  return 'system';
}

function saveTheme(mode: ThemeMode): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_THEME, mode);
  } catch {
    // ignore storage errors
  }
}

function getSystemDark(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

const _themeMode = signal<ThemeMode>(readSavedTheme());
const _systemDark = signal<boolean>(getSystemDark());

export const themeMode: ReadonlySignal<ThemeMode> = _themeMode;

export const resolvedTheme: ReadonlySignal<'light' | 'dark'> = computed(() => {
  const mode = _themeMode.value;
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return _systemDark.value ? 'dark' : 'light';
});

function applyToDom(resolved: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', resolved === 'dark' ? BG_DARK : BG_LIGHT);
  }
}

export function cycleTheme(): ThemeMode {
  const cur = _themeMode.value;
  const next: ThemeMode = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system';
  _themeMode.value = next;
  saveTheme(next);
  applyToDom(resolvedTheme.value);
  return next;
}

export function initTheme(): () => void {
  _themeMode.value = readSavedTheme();
  _systemDark.value = getSystemDark();
  applyToDom(resolvedTheme.value);

  if (typeof globalThis.matchMedia !== 'function') {
    return () => {};
  }

  const mql = globalThis.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (e: MediaQueryListEvent) => {
    _systemDark.value = e.matches;
    applyToDom(resolvedTheme.value);
  };

  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }
  return () => {};
}
