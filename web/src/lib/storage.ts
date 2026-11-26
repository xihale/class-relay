import type { Preset, Role, WarmedMap } from '../types/protocol';

export const VALID_ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;

const STORAGE_ROOM = 'class-relay-room';
const STORAGE_RECENT_ROOMS = 'class-relay-recent-rooms';
const STORAGE_MODE = 'class-relay-mode';
const LEGACY_DEFAULT_ROOM = 'dorm402';
const MAX_RECENT_ROOMS = 5;

function isLegacyDefaultRoom(room: string): boolean {
  return room.trim().toLowerCase() === LEGACY_DEFAULT_ROOM;
}
const STORAGE_AUTO = 'class-relay-auto';
const STORAGE_SOURCE = 'class-relay-source';
const STORAGE_TTL = 'class-relay-ttl';
const STORAGE_PRESETS = 'class-relay-prewarm-v1';
const STORAGE_WARMED = 'class-relay-warmed-v1';
const STORAGE_CID = 'class-relay-cid';

const SOURCES = ['微助教', '雨课堂', '普通链接'];
const TTLS = [60, 90, 180];

const TEACHERMATE_OAUTH_URL =
  'https://open.weixin.qq.com/connect/oauth2/authorize?appid=wxa153455f3ef1d9f9&redirect_uri=https%3A%2F%2Fv18.teachermate.cn%2Fapi%2Fv1%2Fwechat%2Fr%3Fm%3Ds_signin&response_type=code&scope=snsapi_base&state=#wechat_redirect';

export const DEFAULT_PRESETS: Preset[] = [
  {
    id: 'teachermate',
    name: '微助教',
    hint: '微信静默授权并预热学生签到页',
    url: TEACHERMATE_OAUTH_URL,
  },
  {
    id: 'custom',
    name: '自定义入口',
    hint: '绑定课程或学校统一认证首页',
    url: '',
  },
];

function safeReadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJSON(key: string, val: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(val));
  } catch {
    // ignore
  }
}

let cachedCid = '';

export function getClientId(): string {
  if (cachedCid) return cachedCid;
  try {
    const saved = globalThis.sessionStorage?.getItem(STORAGE_CID);
    if (saved && saved.length >= 6) {
      cachedCid = saved;
      return cachedCid;
    }
  } catch {
    // ignore
  }
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(10);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  let id = 'c';
  for (let i = 0; i < buf.length; i++) {
    id += chars[buf[i] % chars.length];
  }
  cachedCid = id;
  try {
    globalThis.sessionStorage?.setItem(STORAGE_CID, id);
  } catch {
    // ignore
  }
  return id;
}

export function loadRecentRooms(): string[] {
  const raw = safeReadJSON<unknown>(STORAGE_RECENT_ROOMS, []);
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (
      typeof item === 'string' &&
      VALID_ROOM_RE.test(item) &&
      !isLegacyDefaultRoom(item) &&
      !out.includes(item)
    ) {
      out.push(item);
      if (out.length >= MAX_RECENT_ROOMS) break;
    }
  }
  return out;
}

export function recordRecentRoom(room: string): string[] {
  const cleaned = String(room || '').trim();
  if (!VALID_ROOM_RE.test(cleaned) || isLegacyDefaultRoom(cleaned)) return loadRecentRooms();
  const next = [cleaned, ...loadRecentRooms().filter((r) => r !== cleaned)].slice(
    0,
    MAX_RECENT_ROOMS,
  );
  safeWriteJSON(STORAGE_RECENT_ROOMS, next);
  return next;
}

export function initialRoom(): string {
  if (typeof location !== 'undefined') {
    const qs = new URLSearchParams(location.search);
    const qRoom = (qs.get('room') || '').trim();
    if (VALID_ROOM_RE.test(qRoom) && !isLegacyDefaultRoom(qRoom)) {
      recordRecentRoom(qRoom);
      return qRoom;
    }
  }
  try {
    globalThis.localStorage?.removeItem(STORAGE_ROOM);
  } catch {
    // ignore
  }
  return randomRoomId();
}

export function initialMode(): Role {
  if (typeof location !== 'undefined') {
    const qs = new URLSearchParams(location.search);
    const qMode = (qs.get('mode') || '').trim().toLowerCase();
    if (qMode === 'send' || qMode === 'recv') {
      try {
        globalThis.localStorage?.setItem(STORAGE_MODE, qMode);
      } catch {
        // ignore
      }
      return qMode;
    }
  }
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_MODE);
    if (saved === 'send' || saved === 'recv') return saved;
  } catch {
    // ignore
  }
  return 'recv';
}

export function randomRoomId(): string {
  const min = 10000;
  const span = 90000; // 10000..99999 (5-digit numeric room)
  for (let attempt = 0; attempt < 8; attempt++) {
    let val: number;
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      val = min + (buf[0] % span);
    } else {
      val = min + Math.floor(Math.random() * span);
    }
    const str = String(val);
    if (!/^(\d)\1{4}$/.test(str)) {
      return str;
    }
  }
  return '48293';
}

export function guessSource(url: string, fallback = '普通链接'): string {
  const lower = String(url || '').toLowerCase();
  if (lower.includes('teachermate')) return '微助教';
  if (lower.includes('yuketang')) return '雨课堂';
  return fallback;
}

export function buildShareUrl(room: string, mode: Role): string {
  const origin = typeof location !== 'undefined' && location.origin ? location.origin : 'http://localhost';
  const url = new URL(origin + '/');
  url.searchParams.set('room', room);
  url.searchParams.set('mode', mode);
  return url.toString();
}

export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback to execCommand
    }
  }
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.className = 'copy-scratch';
  ta.value = text;
  ta.readOnly = true;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function loadAutoRedirect(): boolean {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_AUTO);
    return v === null || v === undefined ? true : v === '1';
  } catch {
    return true;
  }
}

export function saveAutoRedirect(v: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_AUTO, v ? '1' : '0');
  } catch {
    // ignore
  }
}

export function loadSource(): string {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_SOURCE);
    if (v && SOURCES.includes(v)) return v;
  } catch {
    // ignore
  }
  return '微助教';
}

export function saveSource(v: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_SOURCE, v);
  } catch {
    // ignore
  }
}

export function loadTtl(): number {
  try {
    const n = Number(globalThis.localStorage?.getItem(STORAGE_TTL));
    if (TTLS.includes(n)) return n;
  } catch {
    // ignore
  }
  return 90;
}

export function saveTtl(v: number): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_TTL, String(v));
  } catch {
    // ignore
  }
}

export function loadPresets(): Preset[] {
  const saved = safeReadJSON<Array<{ id: string; url?: string }> | null>(STORAGE_PRESETS, null);
  if (!Array.isArray(saved) || !saved.length) {
    return DEFAULT_PRESETS.map((p) => ({ ...p }));
  }
  const map = new Map(saved.map((p) => [p.id, p]));
  return DEFAULT_PRESETS.map((def) => {
    const cur = map.get(def.id);
    if (!cur || typeof cur.url !== 'string') return { ...def };
    return { ...def, url: cur.url };
  });
}

export function savePresets(v: Preset[]): void {
  safeWriteJSON(
    STORAGE_PRESETS,
    v.map(({ id, url }) => ({ id, url })),
  );
}

export function loadWarmed(): WarmedMap {
  const raw = safeReadJSON<Record<string, unknown>>(STORAGE_WARMED, {});
  const out: WarmedMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, val] of Object.entries(raw)) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      out[id] = val;
    } else if (val && typeof val === 'object' && typeof (val as { at?: unknown }).at === 'number') {
      out[id] = (val as { at: number }).at;
    }
  }
  return out;
}

export function recordWarmed(id: string): WarmedMap {
  const warmed = loadWarmed();
  warmed[id] = Date.now();
  safeWriteJSON(STORAGE_WARMED, warmed);
  return warmed;
}

export function formatAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return '刚刚已预热';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前已预热`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时前已预热`;
}

export function latestWarmedSummary(
  warmed: WarmedMap,
  presets: Preset[] = DEFAULT_PRESETS,
): string {
  const presetMap = new Map(presets.map((p) => [p.id, p]));
  let latestId = '';
  let latestTs = 0;

  for (const [id, ts] of Object.entries(warmed || {})) {
    if (!presetMap.has(id)) continue;
    if (typeof ts === 'number' && ts > latestTs) {
      latestTs = ts;
      latestId = id;
    }
  }

  if (!latestId || !latestTs) return '点击提前加载登录态与资源';
  if (Date.now() - latestTs > 6 * 3600 * 1000) return '建议课前重新预热一次';
  const name = presetMap.get(latestId)?.name || latestId;
  return `${name} · ${formatAgo(latestTs)}`;
}

export function remainSeconds(expiresAtLocal: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAtLocal - now) / 1000));
}

export function syncUrl(room: string, mode: Role): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_MODE, mode);
  } catch {
    // ignore
  }
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  try {
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    url.searchParams.set('mode', mode);
    history.replaceState(null, '', url.toString());
  } catch {
    // ignore
  }
}
