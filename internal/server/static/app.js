// 课堂接力 · Class Relay 主入口（纯原生 ES 模块，无构建，严格 CSP）。

import { loadTheme, applyTheme } from './theme.js';
import { h, clear, icon, toast, openDialog } from './dom.js';
import { renderQRDataURL } from './qr.js';
import {
  extractUrl,
  getScannerSupport,
  decodeImageFile,
  openCameraScanner,
  disposeScannerResources,
} from './scanner.js';

const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;
const STORAGE_ROOM = 'class-relay-room';
const STORAGE_MODE = 'class-relay-mode';
const STORAGE_AUTO = 'class-relay-auto';
const STORAGE_SOURCE = 'class-relay-source';
const STORAGE_TTL = 'class-relay-ttl';
const STORAGE_PRESETS = 'class-relay-prewarm-v1';
const STORAGE_WARMED = 'class-relay-warmed-v1';
const SESSION_REDIRECTED = 'class-relay-redirected';
const MAX_REDIRECTED_KEYS = 12;

const SOURCES = ['微助教', '雨课堂', '普通链接'];
const TTLS = [60, 90, 180];
const BACKOFF_MS = [1500, 3000, 6000, 10000];
const REDIRECT_WATCHDOG_MS = 1200;

const TEACHERMATE_OAUTH_URL = 'https://open.weixin.qq.com/connect/oauth2/authorize?appid=wxa153455f3ef1d9f9&redirect_uri=https%3A%2F%2Fv18.teachermate.cn%2Fapi%2Fv1%2Fwechat%2Fr%3Fm%3Ds_signin&response_type=code&scope=snsapi_base&state=#wechat_redirect';

const DEFAULT_PRESETS = [
  { id: 'teachermate', name: '微助教', note: '微信静默授权并预热学生签到页', url: TEACHERMATE_OAUTH_URL },
  { id: 'custom', name: '自定义入口', note: '绑定课程或学校统一认证首页', url: '' },
];

const NON_TAP_JUMP_SELECTOR = 'button, a, input, textarea, [role="switch"], .room-bar, .mode-switch';

function safeReadJSON(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJSON(storage, key, val) {
  try { storage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
}

function hasDocumentFocus() {
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

function initialRoom() {
  const qs = new URLSearchParams(location.search);
  const qRoom = (qs.get('room') || '').trim();
  if (ROOM_RE.test(qRoom)) {
    try { localStorage.setItem(STORAGE_ROOM, qRoom); } catch { /* ignore */ }
    return qRoom;
  }
  try {
    const saved = localStorage.getItem(STORAGE_ROOM);
    if (saved && ROOM_RE.test(saved)) return saved;
  } catch { /* ignore */ }
  return 'dorm402';
}

function initialMode() {
  const qs = new URLSearchParams(location.search);
  const qMode = (qs.get('mode') || '').trim().toLowerCase();
  if (qMode === 'send' || qMode === 'recv') {
    try { localStorage.setItem(STORAGE_MODE, qMode); } catch { /* ignore */ }
    return qMode;
  }
  try {
    const saved = localStorage.getItem(STORAGE_MODE);
    if (saved === 'send' || saved === 'recv') return saved;
  } catch { /* ignore */ }
  return 'recv';
}

function loadAutoRedirect() {
  try {
    const v = localStorage.getItem(STORAGE_AUTO);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

function saveAutoRedirect(v) {
  try { localStorage.setItem(STORAGE_AUTO, v ? '1' : '0'); } catch { /* ignore */ }
}

function loadSource() {
  try {
    const v = localStorage.getItem(STORAGE_SOURCE);
    if (v && SOURCES.includes(v)) return v;
  } catch { /* ignore */ }
  return '微助教';
}

function loadTtl() {
  try {
    const n = Number(localStorage.getItem(STORAGE_TTL));
    if (TTLS.includes(n)) return n;
  } catch { /* ignore */ }
  return 90;
}

function loadPresets() {
  const saved = safeReadJSON(localStorage, STORAGE_PRESETS, null);
  if (!Array.isArray(saved) || !saved.length) return DEFAULT_PRESETS.map((p) => ({ ...p }));
  const map = new Map(saved.map((p) => [p.id, p]));
  return DEFAULT_PRESETS.map((def) => {
    const cur = map.get(def.id);
    if (!cur || typeof cur.url !== 'string') return { ...def };
    return { ...def, url: cur.url };
  });
}

function savePresets(list) {
  safeWriteJSON(localStorage, STORAGE_PRESETS, list.map(({ id, url }) => ({ id, url })));
}

function loadWarmed() {
  const raw = safeReadJSON(localStorage, STORAGE_WARMED, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function recordWarmed(preset) {
  const warmed = { ...state.warmed };
  warmed[preset.id] = { name: preset.name, at: Date.now() };
  state.warmed = warmed;
  safeWriteJSON(localStorage, STORAGE_WARMED, warmed);
}

function formatAgo(ms) {
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return '刚刚已预热';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前已预热`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时前已预热`;
}

function latestWarmedSummary(warmed) {
  let latest = null;
  const activeIds = new Set(DEFAULT_PRESETS.map((p) => p.id));
  for (const [id, item] of Object.entries(warmed || {})) {
    if (!activeIds.has(id)) continue;
    if (item && typeof item.at === 'number' && (!latest || item.at > latest.at)) {
      latest = item;
    }
  }
  if (!latest) return '点击提前加载登录态与资源';
  if (Date.now() - latest.at > 6 * 3600 * 1000) return '建议课前重新预热一次';
  return `${latest.name} · ${formatAgo(latest.at)}`;
}

function randomRoomId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(6);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  let out = 'r';
  for (const b of buf) out += chars[b % chars.length];
  return out;
}

function guessSource(url, fallback) {
  const lower = url.toLowerCase();
  if (lower.includes('teachermate')) return '微助教';
  if (lower.includes('yuketang')) return '雨课堂';
  return fallback;
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fallback */ }
  }
  const ta = h('textarea', { class: 'copy-scratch', value: text, readonly: true });
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function buildShareUrl(room, mode) {
  const url = new URL(location.origin + '/');
  url.searchParams.set('room', room);
  if (mode === 'send') url.searchParams.set('mode', 'send');
  return url.toString();
}

function remainSeconds(expiresAtLocal) {
  return Math.max(0, Math.ceil((expiresAtLocal - Date.now()) / 1000));
}

// ---------- 应用状态 ----------

const initRoomVal = initialRoom();
const initOnline = typeof navigator.onLine === 'boolean' ? navigator.onLine : true;

const state = {
  room: initRoomVal,
  roomDraft: initRoomVal,
  roomBarExpanded: false,
  mode: initialMode(), // 'send' | 'recv'
  seq: 0,
  active: false,
  item: null,
  qrDataUrl: '',
  qrForUrl: '',
  online: initOnline,
  conn: initOnline ? 'connecting' : 'offline', // 'connecting' | 'live' | 'error' | 'offline'
  autoRedirect: loadAutoRedirect(),
  presets: loadPresets(),
  warmed: loadWarmed(),
  redirectNotice: false,

  // 微信焦点感知跳转状态机
  isWeChat: /MicroMessenger/i.test(navigator.userAgent || ''),
  visible: document.visibilityState === 'visible',
  focused: hasDocumentFocus(),
  pendingRedirect: null, // { key, seq, url, source, host, expiresAtLocal }
  redirectStatus: 'idle', // 'idle' | 'navigating' | 'awaiting-focus' | 'blocked' | 'done'
  redirectInFlightKey: null,
  redirectWatchdog: 0,

  // 轮询控制（单调代次防风暴）
  pollGen: 0,
  pollAbort: null,
  retryAbort: null,
  ttlTimer: 0,

  // 发码端状态与扫码资源句柄
  senderUrl: '',
  senderSource: loadSource(),
  senderTtl: loadTtl(),
  senderBusy: false,
  senderProgress: '',
  senderError: '',
  decodeAbort: null,
  cameraHandle: null,
};

// 持久化外壳与局部节点引用（避免全量销毁 DOM）
const ui = {
  mounted: false,
  shell: null,
  statusChip: null,
  statusDot: null,
  statusText: null,
  roleSendBtn: null,
  roleRecvBtn: null,
  roomBar: null,
  roomCodeText: null,
  roomQuickCopyBtn: null,
  roomToggleBtn: null,
  roomDrawer: null,
  roomInput: null,
  mainSlot: null,
  prewarmSlot: null,

  // 主卡片缓存键与子引用
  mainKey: '',
  sender: null,
  recv: null,
};

// 隐藏的图片选择器（不设 capture，允许用户同时选择相册或拍照）。
const fileInput = h('input', {
  type: 'file',
  accept: 'image/*',
  hidden: true,
  onchange: async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    await handleImageFile(file);
  },
});
document.body.append(fileInput);

function syncUrl() {
  const url = new URL(location.href);
  url.searchParams.set('room', state.room);
  url.searchParams.set('mode', state.mode);
  history.replaceState(null, '', url.toString());
}

// ---------- 跳转去重存储（有界 12 条 JSON 数组） ----------

function redirectedKey(item) {
  return `${state.room}:${item.seq}:${item.url}`;
}

function loadRedirectedKeys() {
  try {
    const raw = sessionStorage.getItem(SESSION_REDIRECTED);
    if (!raw) return [];
    if (raw.startsWith('[')) {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : [];
    }
    return [raw];
  } catch {
    return [];
  }
}

function hasRedirectedKey(key) {
  if (!key) return false;
  return loadRedirectedKeys().includes(key);
}

function markRedirectedKey(key) {
  if (!key) return;
  try {
    const next = loadRedirectedKeys().filter((k) => k !== key);
    next.push(key);
    if (next.length > MAX_REDIRECTED_KEYS) {
      next.splice(0, next.length - MAX_REDIRECTED_KEYS);
    }
    sessionStorage.setItem(SESSION_REDIRECTED, JSON.stringify(next));
  } catch { /* ignore */ }
}

function clearRedirectWatchdog() {
  if (state.redirectWatchdog) {
    clearTimeout(state.redirectWatchdog);
    state.redirectWatchdog = 0;
  }
}

function clearPendingRedirect() {
  clearRedirectWatchdog();
  state.pendingRedirect = null;
  state.redirectInFlightKey = null;
  state.redirectStatus = 'idle';
  updateTapJumpClass();
}

function confirmInFlightRedirect() {
  if (!state.redirectInFlightKey) return;
  markRedirectedKey(state.redirectInFlightKey);
  state.redirectInFlightKey = null;
  state.redirectNotice = true;
  state.redirectStatus = 'done';
  clearRedirectWatchdog();
}

function isTapJumpArmed() {
  return (
    state.mode === 'recv' &&
    Boolean(state.pendingRedirect) &&
    (state.redirectStatus === 'awaiting-focus' || state.redirectStatus === 'blocked')
  );
}

function updateTapJumpClass() {
  if (ui.shell) {
    ui.shell.classList.toggle('tap-jump-active', isTapJumpArmed());
  }
}

// ---------- 微信焦点感知自动跳转执行器 ----------

function tryExecutePendingRedirect({ fromGesture = false } = {}) {
  const pending = state.pendingRedirect;
  if (!pending) return false;

  const valid =
    state.mode === 'recv' &&
    state.active &&
    state.item &&
    state.item.seq === pending.seq &&
    pending.expiresAtLocal > Date.now() &&
    !hasRedirectedKey(pending.key);

  if (!valid) {
    if (hasRedirectedKey(pending.key)) {
      clearRedirectWatchdog();
      state.pendingRedirect = null;
      state.redirectInFlightKey = null;
      state.redirectStatus = 'done';
      state.redirectNotice = true;
    } else {
      clearPendingRedirect();
    }
    updateTapJumpClass();
    updateRedirectPromptInPlace();
    updateStatusChipInPlace();
    return false;
  }

  // 防重入：已在跳转中且非用户显式手势，不重复发起。
  if (state.redirectStatus === 'navigating' && !fromGesture) {
    return false;
  }

  // 焦点门控：非手势触发且页面不可见或未获焦点时，不标记已跳转，改为醒目轻触提示。
  if (!fromGesture) {
    const canAuto = document.visibilityState === 'visible' && hasDocumentFocus();
    if (!canAuto) {
      state.redirectStatus = 'awaiting-focus';
      ensureQR(pending.url);
      updateTapJumpClass();
      updateRedirectPromptInPlace();
      updateRecvQrInPlace();
      updateStatusChipInPlace();
      return false;
    }
  }

  clearRedirectWatchdog();
  state.redirectInFlightKey = pending.key;
  state.redirectStatus = 'navigating';
  if (fromGesture) {
    markRedirectedKey(pending.key);
    state.redirectNotice = true;
  }
  updateTapJumpClass();
  updateRedirectPromptInPlace();
  updateStatusChipInPlace();

  // 同步执行 location.assign（保留微信返回键历史，严禁 120ms 延迟与 location.replace）。
  window.location.assign(pending.url);

  // 1200ms 停滞看门狗：若仍停留在可见页，说明微信拦截或延迟了自动跳转。
  const expectedKey = pending.key;
  state.redirectWatchdog = setTimeout(() => {
    state.redirectWatchdog = 0;
    if (document.visibilityState === 'visible' && state.redirectInFlightKey === expectedKey) {
      state.redirectInFlightKey = null;
      state.redirectStatus = 'blocked';
      ensureQR(pending.url);
      updateTapJumpClass();
      updateRedirectPromptInPlace();
      updateRecvQrInPlace();
      updateStatusChipInPlace();
    }
  }, REDIRECT_WATCHDOG_MS);

  return true;
}

// ---------- 资源清理与切换 ----------

function cleanupScannerInteraction() {
  if (state.decodeAbort) {
    state.decodeAbort.abort();
    state.decodeAbort = null;
  }
  if (state.cameraHandle) {
    const handle = state.cameraHandle;
    state.cameraHandle = null;
    try { handle.close(); } catch { /* ignore */ }
  }
}

function setMode(nextMode) {
  if ((nextMode !== 'send' && nextMode !== 'recv') || nextMode === state.mode) return;
  cleanupScannerInteraction();
  if (nextMode !== 'recv') {
    clearPendingRedirect();
  }
  state.mode = nextMode;
  try { localStorage.setItem(STORAGE_MODE, nextMode); } catch { /* ignore */ }
  syncUrl();
  if (nextMode === 'recv' && state.active && state.item) {
    ensureQR(state.item.url);
  }
  syncShell();
}

function setRoom(nextRoom) {
  const trimmed = String(nextRoom || '').trim();
  if (!ROOM_RE.test(trimmed)) {
    toast('房间口令需为 3–32 位字母、数字、_ 或 -');
    return false;
  }
  state.roomDraft = trimmed;
  if (trimmed === state.room) {
    state.roomBarExpanded = false;
    updateRoomBarInPlace();
    return true;
  }
  cleanupScannerInteraction();
  clearPendingRedirect();
  state.room = trimmed;
  state.roomBarExpanded = false;
  state.seq = 0;
  state.active = false;
  state.item = null;
  state.qrDataUrl = '';
  state.qrForUrl = '';
  state.redirectNotice = false;
  try { localStorage.setItem(STORAGE_ROOM, trimmed); } catch { /* ignore */ }
  syncUrl();
  syncTtlTimer();
  syncShell();
  restartPolling();
  toast(`已切换到房间 ${trimmed}`);
  return true;
}

function ensureQR(url) {
  if (!url || state.mode !== 'recv') return '';
  if (state.qrForUrl === url && state.qrDataUrl) return state.qrDataUrl;
  try {
    state.qrDataUrl = renderQRDataURL(url, 260);
    state.qrForUrl = url;
  } catch {
    state.qrDataUrl = '';
    state.qrForUrl = '';
  }
  return state.qrDataUrl;
}

// ---------- 轮询状态机（防 Abort 风暴 + 指数退避 + 离线感知） ----------

function abortActivePoll() {
  if (state.pollAbort) {
    state.pollAbort.abort();
    state.pollAbort = null;
  }
  if (state.retryAbort) {
    state.retryAbort.abort();
    state.retryAbort = null;
  }
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(tid);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const tid = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function pollOnce(waitSec, room) {
  if (state.pollAbort) state.pollAbort.abort();
  const ac = new AbortController();
  state.pollAbort = ac;
  const url = `/api/v1/relay/${encodeURIComponent(room)}?since=${state.seq}&wait=${waitSec}`;
  const resp = await fetch(url, { signal: ac.signal, cache: 'no-store' });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

function applyPayload(data, expectedRoom) {
  if (expectedRoom && expectedRoom !== state.room) return;
  if (data && data.room && data.room !== state.room) return;

  const prevActive = state.active;
  const prevSeq = state.item ? state.item.seq : 0;

  state.conn = 'live';
  state.seq = typeof data.seq === 'number' ? data.seq : state.seq;

  if (!data.active || !data.url) {
    clearPendingRedirect();
    state.active = false;
    state.item = null;
    state.redirectNotice = false;
    syncTtlTimer();
    if (prevActive) {
      syncMainSlot();
    }
    updateStatusChipInPlace();
    return;
  }

  const drift = typeof data.serverTime === 'number' ? data.serverTime - Date.now() : 0;
  const item = {
    seq: data.seq,
    url: data.url,
    source: data.source || '课堂链接',
    host: data.host || '',
    expiresAtLocal: (data.expiresAt || Date.now() + 90000) - drift,
  };
  const key = redirectedKey(item);
  const alreadyDone = hasRedirectedKey(key);

  state.active = true;
  state.item = item;
  state.redirectNotice = alreadyDone;

  const itemChanged = !prevActive || prevSeq !== item.seq;

  // 仅在 recv 模式且开启自动跳转且未跳转过时，先进入焦点门控跳转流程，绝不提前同步生成 QR。
  let deferQr = false;
  if (state.mode === 'recv') {
    if (state.autoRedirect && !alreadyDone) {
      const samePending = state.pendingRedirect && state.pendingRedirect.key === key;
      if (!samePending) {
        clearRedirectWatchdog();
        state.pendingRedirect = {
          key,
          seq: item.seq,
          url: item.url,
          source: item.source,
          host: item.host,
          expiresAtLocal: item.expiresAtLocal,
        };
        state.redirectStatus = 'idle';
      }
      deferQr = true;
    } else {
      if (state.pendingRedirect && state.pendingRedirect.key !== key) {
        clearPendingRedirect();
      }
      state.redirectStatus = alreadyDone ? 'done' : 'idle';
      ensureQR(item.url);
    }
  } else {
    clearPendingRedirect();
  }

  syncTtlTimer();
  if (itemChanged) {
    syncMainSlot();
  } else {
    updateTtlInPlace();
    updateRedirectPromptInPlace();
  }
  updateStatusChipInPlace();

  if (deferQr) {
    tryExecutePendingRedirect({ fromGesture: false });
  }
}

async function runPollLoop(gen, immediateFirst) {
  let first = immediateFirst;
  let attempt = 0;

  while (gen === state.pollGen) {
    if (!state.visible || !state.online) {
      if (!state.online) {
        state.conn = 'offline';
        updateStatusChipInPlace();
      }
      return;
    }

    const reqRoom = state.room;
    try {
      const waitSec = first ? 0 : 15;
      first = false;
      const data = await pollOnce(waitSec, reqRoom);
      if (gen !== state.pollGen) return;
      attempt = 0;
      applyPayload(data, reqRoom);
    } catch (err) {
      if (gen !== state.pollGen) return;
      if (err && err.name === 'AbortError') return;

      if (!state.online || (typeof navigator.onLine === 'boolean' && !navigator.onLine)) {
        state.online = false;
        state.conn = 'offline';
        updateStatusChipInPlace();
        return;
      }

      state.conn = 'error';
      updateStatusChipInPlace();

      const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      const floor = err && err.status === 429 ? Math.max(base, 3000) : base;
      attempt += 1;
      const delay = Math.round(floor * (0.8 + Math.random() * 0.4));

      const sleepAc = new AbortController();
      state.retryAbort = sleepAc;
      try {
        await sleepAbortable(delay, sleepAc.signal);
      } catch {
        return;
      }
      if (gen !== state.pollGen) return;
      state.retryAbort = null;
      first = true;
    }
  }
}

function stopPolling() {
  state.pollGen += 1;
  abortActivePoll();
}

function restartPolling() {
  const gen = ++state.pollGen;
  abortActivePoll();
  if (!state.online) {
    state.conn = 'offline';
    updateStatusChipInPlace();
    return;
  }
  if (!state.visible) return;
  state.conn = 'connecting';
  updateStatusChipInPlace();
  runPollLoop(gen, true);
}

// ---------- 发码端逻辑 ----------

async function pushUrl(rawUrl, sourceOverride) {
  const url = extractUrl(rawUrl);
  if (!url) {
    state.senderError = '未识别到合法的 http:// 或 https:// 链接';
    updateSenderInPlace();
    return false;
  }
  const source = sourceOverride || guessSource(url, state.senderSource);
  state.senderSource = source;
  try { localStorage.setItem(STORAGE_SOURCE, source); } catch { /* ignore */ }

  state.senderBusy = true;
  state.senderError = '';
  updateSenderInPlace();

  const targetRoom = state.room;
  try {
    const resp = await fetch(`/api/v1/relay/${encodeURIComponent(targetRoom)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, source, ttlSec: state.senderTtl }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || `HTTP ${resp.status}`);
    if (targetRoom !== state.room) return false;
    state.senderUrl = url;
    applyPayload({
      room: targetRoom,
      active: true,
      seq: data.seq,
      url: data.url || url,
      source: data.source || source,
      host: data.host || '',
      expiresAt: data.expiresAt,
      serverTime: data.serverTime,
    }, targetRoom);
    toast(`已发送到房间 ${targetRoom}`);
    return true;
  } catch (err) {
    state.senderError = (err && err.message) || '发送失败，请稍后重试';
    toast(state.senderError);
    return false;
  } finally {
    state.senderBusy = false;
    updateSenderInPlace();
  }
}

async function handleScannedText(rawText) {
  const text = String(rawText || '').trim();
  const url = extractUrl(text);
  if (!url) {
    state.senderUrl = text;
    state.senderError = '二维码内容不包含 http(s):// 链接，已填入下方文本框供核对';
    updateSenderInPlace(true);
    toast('未识别到网址，请检查二维码内容');
    return;
  }
  state.senderUrl = url;
  updateSenderInPlace(true);
  await pushUrl(url, guessSource(url, state.senderSource));
}

function getScanBadgeInfo() {
  let support = { camera: false, barcodeDetector: false, wasmWorker: false };
  try {
    support = getScannerSupport() || support;
  } catch { /* ignore */ }
  if (support.camera) {
    return {
      ready: true,
      label: support.barcodeDetector
        ? '高清远距扫码就绪（原生加速 + 变焦）'
        : '高清远距扫码就绪（支持变焦与拍照识码）',
    };
  }
  return {
    ready: false,
    label: '当前环境不支持实时相机（需 HTTPS），请使用「拍照 / 相册识码」',
  };
}

function handlePrimaryScan() {
  if (state.senderBusy) return;
  openWebScanner();
}

function openWebScanner() {
  if (state.cameraHandle) {
    try { state.cameraHandle.close(); } catch { /* ignore */ }
    state.cameraHandle = null;
  }
  state.cameraHandle = openCameraScanner({
    onResult: (text) => { handleScannedText(text); },
    onPickFile: () => { fileInput.click(); },
    onClose: () => { state.cameraHandle = null; },
  });
}

async function handleImageFile(file) {
  if (state.decodeAbort) {
    state.decodeAbort.abort();
  }
  const ac = new AbortController();
  state.decodeAbort = ac;

  state.senderBusy = true;
  state.senderProgress = '正在读取原图…';
  state.senderError = '';
  updateSenderInPlace();

  try {
    const text = await decodeImageFile(file, {
      signal: ac.signal,
      onProgress: (info) => {
        if (ac.signal.aborted) return;
        const label = typeof info === 'string'
          ? info
          : (info && typeof info.label === 'string' ? info.label : '');
        if (label) {
          state.senderProgress = label;
          updateSenderInPlace();
        }
      },
    });
    if (ac.signal.aborted) return;
    state.decodeAbort = null;
    state.senderBusy = false;
    state.senderProgress = '';
    updateSenderInPlace();
    await handleScannedText(text);
  } catch (err) {
    if (state.decodeAbort === ac) state.decodeAbort = null;
    state.senderBusy = false;
    state.senderProgress = '';
    if (err && err.name === 'AbortError') {
      updateSenderInPlace();
      return;
    }
    state.senderError = (err && err.message) || '图片识码失败';
    toast(state.senderError);
    updateSenderInPlace();
  }
}

async function handlePasteOrExtract() {
  const existing = extractUrl(state.senderUrl);
  if (existing && existing !== state.senderUrl.trim()) {
    state.senderUrl = existing;
    state.senderError = '';
    updateSenderInPlace(true);
    toast('已从文本中提取链接');
    return;
  }
  if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (clip) {
        const extracted = extractUrl(clip);
        state.senderUrl = extracted || clip;
        state.senderError = extracted ? '' : '剪贴板内容未检测到 http(s):// 链接';
        updateSenderInPlace(true);
        toast(extracted ? '已粘贴并提取链接' : '已粘贴剪贴板内容');
        return;
      }
    } catch { /* fall through */ }
  }
  toast('请长按输入框手动粘贴链接');
}

async function clearActiveItem() {
  try {
    await fetch(`/api/v1/relay/${encodeURIComponent(state.room)}`, { method: 'DELETE' });
    clearPendingRedirect();
    state.active = false;
    state.item = null;
    state.redirectNotice = false;
    syncTtlTimer();
    syncMainSlot();
    updateStatusChipInPlace();
    toast('已清除当前签到码');
  } catch {
    toast('清除失败，请稍后重试');
  }
}

// ---------- 课前预热对话框 ----------

function openPresetEditDialog(preset, onSaved) {
  const input = h('input', {
    class: 'input relay-tonal-input',
    type: 'url',
    value: preset.url,
    placeholder: 'https://...',
  });
  const errEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', {
    class: 'form',
    onsubmit: (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (val && !/^https?:\/\/\S+/i.test(val)) {
        errEl.textContent = '请输入以 http:// 或 https:// 开头的有效地址';
        errEl.hidden = false;
        return;
      }
      preset.url = val;
      savePresets(state.presets);
      dlg.close();
      updatePrewarmInPlace();
      if (onSaved && val) onSaved(preset);
    },
  },
    h('div', { class: 'sheet-head' },
      h('h2', {}, `配置 ${preset.name}`),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '关闭', onclick: () => dlg.close() }, icon('x'))),
    h('div', { class: 'relay-sheet-fields' },
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, '学生端网页入口'),
        input),
      h('p', { class: 'hint' }, '跳转后请在目标页完成登录，再按微信左上角「← 返回」即可保留鉴权与缓存。'),
      errEl),
    h('div', { class: 'sheet-foot' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, '取消'),
      h('button', { type: 'submit', class: 'btn primary' }, '保存')));
  const dlg = openDialog(form, { label: `配置 ${preset.name}` });
  setTimeout(() => input.focus(), 50);
}

function startPrewarm(preset) {
  if (!preset.url) {
    openPresetEditDialog(preset, (saved) => startPrewarm(saved));
    return;
  }
  recordWarmed(preset);
  updatePrewarmInPlace();
  window.location.assign(preset.url);
}

// ---------- 局部原地更新函数 ----------

function updateStatusChipInPlace() {
  if (!ui.statusChip) return;

  let dotCls = '';
  let text = '连接中';
  let interactive = false;
  let extraChipCls = '';
  let ariaLabel = '';

  if (!state.online || state.conn === 'offline') {
    dotCls = 'err';
    text = '网络已断开';
    interactive = true;
    extraChipCls = 'err-chip';
    ariaLabel = '网络已断开，点击尝试重新连接';
  } else if (state.mode === 'recv' && state.pendingRedirect && state.redirectStatus === 'awaiting-focus') {
    dotCls = 'warn';
    text = '待轻触跳转';
    interactive = true;
    extraChipCls = 'warn-chip';
    ariaLabel = '待轻触跳转，点击立即前往签到';
  } else if (state.mode === 'recv' && state.pendingRedirect && state.redirectStatus === 'blocked') {
    dotCls = 'err';
    text = '跳转被拦截';
    interactive = true;
    extraChipCls = 'err-chip';
    ariaLabel = '自动跳转被拦截，点击立即前往签到';
  } else if (state.conn === 'error') {
    dotCls = 'err';
    text = '连接中断 · 重试';
    interactive = true;
    extraChipCls = 'err-chip';
    ariaLabel = '连接中断，点击立即重连';
  } else if (state.active) {
    dotCls = 'active';
    text = '已收到新码';
  } else if (state.conn === 'live') {
    dotCls = 'live';
    text = '实时等待中';
  }

  ui.statusDot.className = `relay-dot ${dotCls}`.trim();
  ui.statusText.textContent = text;
  ui.statusChip.disabled = !interactive;
  ui.statusChip.className = `sync-chip${interactive ? ' interactive' : ''}${extraChipCls ? ` ${extraChipCls}` : ''}`;
  if (ariaLabel) {
    ui.statusChip.setAttribute('aria-label', ariaLabel);
    ui.statusChip.title = ariaLabel;
  } else {
    ui.statusChip.removeAttribute('aria-label');
    ui.statusChip.removeAttribute('title');
  }
}

function updateRoleSwitcherInPlace() {
  if (!ui.roleSendBtn || !ui.roleRecvBtn) return;
  ui.roleSendBtn.setAttribute('aria-pressed', String(state.mode === 'send'));
  ui.roleRecvBtn.setAttribute('aria-pressed', String(state.mode === 'recv'));
}

function updateRoomBarInPlace() {
  if (!ui.roomBar) return;
  ui.roomCodeText.textContent = state.room;
  ui.roomBar.classList.toggle('expanded', state.roomBarExpanded);
  ui.roomDrawer.hidden = !state.roomBarExpanded;
  ui.roomToggleBtn.setAttribute('aria-expanded', String(state.roomBarExpanded));
  if (document.activeElement !== ui.roomInput && ui.roomInput.value !== state.roomDraft) {
    ui.roomInput.value = state.roomDraft;
  }
}

function updateTtlInPlace() {
  if (!state.active || !state.item) return;
  const remain = remainSeconds(state.item.expiresAtLocal);
  const el = document.getElementById('relay-ttl');
  if (el) {
    el.textContent = `${remain}s 后过期`;
    el.classList.toggle('urgent', remain <= 15);
  }
  if (ui.recv && ui.recv.promptSub && state.pendingRedirect && state.redirectStatus === 'awaiting-focus') {
    ui.recv.promptSub.textContent = `已收到 ${state.pendingRedirect.source} 签到码（剩余 ${remain}s）`;
  }
}

function updateRedirectPromptInPlace() {
  if (!ui.recv || !ui.recv.promptSlot) return;
  const slot = ui.recv.promptSlot;
  clear(slot);
  ui.recv.promptSub = null;

  const pending = state.pendingRedirect;
  const showAwaiting = state.mode === 'recv' && pending && state.redirectStatus === 'awaiting-focus';
  const showBlocked = state.mode === 'recv' && pending && state.redirectStatus === 'blocked';

  if (ui.recv.noticeEl) {
    ui.recv.noticeEl.hidden = !state.redirectNotice || showAwaiting || showBlocked;
  }

  if (!showAwaiting && !showBlocked) {
    slot.hidden = true;
    return;
  }

  slot.hidden = false;
  const remain = remainSeconds(pending.expiresAtLocal);

  if (showAwaiting) {
    const sub = h('p', { class: 'redirect-prompt-sub' }, `已收到 ${pending.source} 签到码（剩余 ${remain}s）`);
    ui.recv.promptSub = sub;
    slot.append(
      h('div', { class: 'redirect-prompt', role: 'alert', 'aria-live': 'assertive' },
        h('div', { class: 'redirect-prompt-text' },
          h('strong', { class: 'redirect-prompt-title' }, '未获取焦点，轻触屏幕即可自动跳转'),
          sub),
        h('button', {
          type: 'button',
          class: 'btn primary hero',
          onclick: () => tryExecutePendingRedirect({ fromGesture: true }),
        }, icon('external', 18), '立即跳转')),
    );
    return;
  }

  // blocked 状态：提供零 JS 兜底原生 <a href> 按钮
  slot.append(
    h('div', { class: 'redirect-prompt blocked', role: 'alert', 'aria-live': 'assertive' },
      h('div', { class: 'redirect-prompt-text' },
        h('strong', { class: 'redirect-prompt-title' }, '微信拦截了自动跳转，轻触立即前往'),
        h('p', { class: 'redirect-prompt-sub' }, '点击任意提示区或下方按钮直接打开')),
      h('a', {
        class: 'btn primary hero',
        href: pending.url,
        onclick: () => {
          markRedirectedKey(pending.key);
          clearPendingRedirect();
          state.redirectStatus = 'done';
          state.redirectNotice = true;
        },
      }, icon('external', 18), '立即前往签到')),
  );
}

function updateRecvQrInPlace() {
  if (!ui.recv || !ui.recv.qrSlot || !state.active || !state.item) return;
  const slot = ui.recv.qrSlot;
  if (!state.qrDataUrl || state.qrForUrl !== state.item.url) {
    slot.hidden = true;
    return;
  }
  const existingImg = slot.querySelector('.relay-qr-img');
  if (existingImg && existingImg.getAttribute('src') === state.qrDataUrl) {
    slot.hidden = false;
    return;
  }
  clear(slot);
  slot.hidden = false;
  slot.append(
    h('div', { class: 'relay-qr-wrap' },
      h('img', { class: 'relay-qr-img', src: state.qrDataUrl, alt: '兜底签到二维码' }),
      h('p', { class: 'hint center' }, '若自动跳转被拦截，可长按二维码识别')),
  );
}

function updateSenderPreviewInPlace() {
  if (!ui.sender || !ui.sender.previewSlot) return;
  const slot = ui.sender.previewSlot;
  clear(slot);
  if (!state.active || !state.item) {
    slot.hidden = true;
    return;
  }
  const { item } = state;
  const remain = remainSeconds(item.expiresAtLocal);
  slot.hidden = false;
  slot.append(
    h('div', { class: 'sender-preview' },
      h('div', { class: 'relay-active-head' },
        h('div', { class: 'relay-badges' },
          h('span', { class: 'relay-pill' }, item.source),
          h('span', { class: `relay-pill ttl${remain <= 15 ? ' urgent' : ''}`, id: 'relay-ttl' }, `${remain}s 后过期`)),
        h('button', { type: 'button', class: 'btn small danger-ghost', onclick: clearActiveItem }, '清除')),
      h('div', { class: 'stack-sm' },
        h('b', {}, item.host || '当前房间有效链接'),
        h('p', { class: 'relay-url' }, item.url))),
  );
}

function updateSenderInPlace(syncInputValue = false) {
  if (!ui.sender) return;
  const s = ui.sender;
  if (syncInputValue && s.urlInput.value !== state.senderUrl) {
    s.urlInput.value = state.senderUrl;
  }
  s.scanBtn.disabled = state.senderBusy;
  s.fileBtn.disabled = state.senderBusy;
  s.fileBtnText.textContent = state.senderProgress || '拍照 / 相册识码';
  s.submitBtn.disabled = state.senderBusy;
  s.submitBtnText.textContent = state.senderBusy ? '发送中…' : '推送到房间';
  s.clearBtn.disabled = !state.active;

  for (const [val, btn] of s.sourceBtns) {
    btn.setAttribute('aria-pressed', String(val === state.senderSource));
  }
  for (const [val, btn] of s.ttlBtns) {
    btn.setAttribute('aria-pressed', String(val === state.senderTtl));
  }

  if (state.senderError) {
    s.errorEl.textContent = state.senderError;
    s.errorEl.hidden = false;
    s.urlInput.setAttribute('aria-describedby', 'sender-url-error');
  } else {
    s.errorEl.textContent = '';
    s.errorEl.hidden = true;
    s.urlInput.removeAttribute('aria-describedby');
  }
}

function updatePrewarmInPlace() {
  if (!ui.prewarmSlot) return;
  if (state.mode !== 'recv') {
    ui.prewarmSlot.hidden = true;
    return;
  }
  ui.prewarmSlot.hidden = false;
  clear(ui.prewarmSlot);

  const rows = state.presets.map((p) => {
    const w = state.warmed[p.id];
    const sub = p.url ? p.url : p.note;
    return h('div', { class: 'relay-prewarm-row' },
      h('div', { class: 'relay-prewarm-meta' },
        h('div', { class: 'relay-prewarm-name' },
          h('span', {}, p.name),
          w ? h('span', { class: 'relay-prewarm-tag' }, formatAgo(w.at)) : null),
        h('span', { class: 'relay-prewarm-sub' }, sub)),
      h('div', { class: 'relay-prewarm-actions' },
        h('button', {
          type: 'button',
          class: 'icon-btn',
          'aria-label': `编辑 ${p.name} 入口`,
          onclick: () => openPresetEditDialog(p),
        }, icon('edit', 18)),
        h('button', {
          type: 'button',
          class: 'btn small tonal',
          onclick: () => startPrewarm(p),
        }, p.url ? '去预热' : '配置')));
  });

  ui.prewarmSlot.append(
    h('section', { class: 'relay-section' },
      h('div', { class: 'relay-section-head' },
        h('span', { class: 'relay-section-title' }, '课前预热'),
        h('span', { class: 'relay-section-status' }, latestWarmedSummary(state.warmed))),
      h('div', { class: 'relay-prewarm-list' }, ...rows)),
  );
}

// ---------- 卡片构建（按结构键重建，避免无谓销毁） ----------

function buildSenderCard() {
  const scanCap = getScanBadgeInfo();
  const badgeCls = scanCap.ready ? 'ready' : 'warn';

  const urlInput = h('textarea', {
    id: 'sender-url-input',
    class: 'input relay-tonal-input',
    value: state.senderUrl,
    placeholder: '粘贴包含 http(s):// 的签到链接或文本',
    oninput: (e) => {
      state.senderUrl = e.target.value;
      if (state.senderError) {
        state.senderError = '';
        updateSenderInPlace();
      }
    },
  });

  const sourceBtns = new Map();
  const sourceGroup = h('div', { class: 'seg', role: 'group', 'aria-label': '来源平台' },
    ...SOURCES.map((s) => {
      const btn = h('button', {
        type: 'button',
        class: 'seg-btn',
        'aria-pressed': String(s === state.senderSource),
        onclick: () => {
          state.senderSource = s;
          try { localStorage.setItem(STORAGE_SOURCE, s); } catch { /* ignore */ }
          updateSenderInPlace();
        },
      }, s);
      sourceBtns.set(s, btn);
      return btn;
    }));

  const ttlBtns = new Map();
  const ttlGroup = h('div', { class: 'seg', role: 'group', 'aria-label': '有效时长' },
    ...TTLS.map((t) => {
      const btn = h('button', {
        type: 'button',
        class: 'seg-btn',
        'aria-pressed': String(t === state.senderTtl),
        onclick: () => {
          state.senderTtl = t;
          try { localStorage.setItem(STORAGE_TTL, String(t)); } catch { /* ignore */ }
          updateSenderInPlace();
        },
      }, `${t} 秒`);
      ttlBtns.set(t, btn);
      return btn;
    }));

  const errorEl = h('p', { id: 'sender-url-error', class: 'form-error', role: 'alert', hidden: true });
  const submitBtnText = h('span', {}, '推送到房间');
  const submitBtn = h('button', { type: 'submit', class: 'btn primary' }, icon('send', 18), submitBtnText);
  const clearBtn = h('button', {
    type: 'button',
    class: 'btn danger-ghost',
    onclick: clearActiveItem,
  }, icon('trash', 18), '清除');

  const scanBtn = h('button', {
    type: 'button',
    class: 'btn primary hero',
    onclick: handlePrimaryScan,
  }, icon('scan', 22), '扫一扫并发送');

  const fileBtnText = h('span', {}, '拍照 / 相册识码');
  const fileBtn = h('button', {
    type: 'button',
    class: 'btn tonal wide-btn',
    onclick: () => fileInput.click(),
  }, icon('image', 18), fileBtnText);

  const previewSlot = h('div', { hidden: true });

  const pasteForm = h('form', {
    class: 'sender-form',
    onsubmit: async (e) => {
      e.preventDefault();
      await pushUrl(state.senderUrl, state.senderSource);
    },
  },
    h('div', { class: 'field' },
      h('div', { class: 'field-head' },
        h('label', { class: 'field-label', for: 'sender-url-input' }, '粘贴链接发送'),
        h('button', {
          type: 'button',
          class: 'btn small ghost',
          onclick: handlePasteOrExtract,
        }, '粘贴 / 提取')),
      urlInput),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, '签到平台'),
      sourceGroup),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, '有效时长'),
      ttlGroup),
    errorEl,
    h('div', { class: 'sender-form-actions' }, submitBtn, clearBtn));

  ui.sender = {
    urlInput,
    sourceBtns,
    ttlBtns,
    errorEl,
    submitBtn,
    submitBtnText,
    clearBtn,
    scanBtn,
    fileBtn,
    fileBtnText,
    previewSlot,
  };

  const card = h('section', { class: 'card relay-card' },
    h('div', { class: `scan-badge ${badgeCls}` },
      h('span', { class: `relay-dot ${scanCap.ready ? 'live' : ''}`.trim() }),
      h('span', {}, scanCap.label)),
    h('div', { class: 'sender-scan-actions' }, scanBtn, fileBtn),
    previewSlot,
    h('div', { class: 'sender-divider' }, '或手动粘贴链接'),
    pasteForm);

  updateSenderInPlace(true);
  updateSenderPreviewInPlace();
  return card;
}

function buildSwitchRow() {
  const switchBtn = h('button', {
    type: 'button',
    class: 'relay-switch',
    role: 'switch',
    'aria-checked': String(state.autoRedirect),
    'aria-label': '收到新码自动跳转',
    onclick: () => {
      state.autoRedirect = !state.autoRedirect;
      saveAutoRedirect(state.autoRedirect);
      switchBtn.setAttribute('aria-checked', String(state.autoRedirect));
      if (!state.autoRedirect) {
        clearPendingRedirect();
        updateRedirectPromptInPlace();
        updateStatusChipInPlace();
      }
    },
  });
  return {
    switchBtn,
    row: h('div', { class: 'relay-switch-row' },
      h('div', { class: 'relay-switch-text' },
        h('b', {}, '收到新码自动跳转'),
        h('span', {}, '使用 location.assign，保留微信左上角返回键')),
      switchBtn),
  };
}

function buildReceiverWaitCard() {
  const { switchBtn, row } = buildSwitchRow();
  ui.recv = { promptSlot: null, promptSub: null, noticeEl: null, qrSlot: null, switchBtn };
  return h('section', { class: 'card relay-card' },
    h('div', { class: 'relay-wait' },
      h('div', { class: 'relay-emblem' }, icon('sparkle', 28)),
      h('h2', {}, '等待教室端传码'),
      h('p', {}, '建议将本页设为微信「浮窗」，收到通知点回即可接力签到')),
    row);
}

function buildReceiverActiveCard() {
  const { item } = state;
  const remain = remainSeconds(item.expiresAtLocal);
  const { switchBtn, row } = buildSwitchRow();

  const promptSlot = h('div', { hidden: true });
  const noticeEl = h('p', { class: 'relay-notice', hidden: !state.redirectNotice },
    '本条链接已自动跳转过；如需再次打开，请点击下方按钮或长按二维码。');
  const qrSlot = h('div', { hidden: true });

  ui.recv = { promptSlot, promptSub: null, noticeEl, qrSlot, switchBtn };

  const card = h('section', { class: 'card relay-card' },
    promptSlot,
    h('div', { class: 'relay-active-head' },
      h('div', { class: 'relay-badges' },
        h('span', { class: 'relay-pill' }, item.source),
        h('span', { class: `relay-pill ttl${remain <= 15 ? ' urgent' : ''}`, id: 'relay-ttl' }, `${remain}s 后过期`)),
      h('button', { type: 'button', class: 'btn small ghost', onclick: clearActiveItem }, '清除')),
    h('div', { class: 'stack-sm' },
      h('h2', { class: 'relay-host' }, item.host || '签到链接已就绪'),
      h('p', { class: 'relay-url' }, item.url)),
    noticeEl,
    h('div', { class: 'relay-cta-col' },
      h('a', {
        class: 'btn primary hero',
        href: item.url,
        onclick: () => {
          markRedirectedKey(redirectedKey(item));
          clearPendingRedirect();
          state.redirectStatus = 'done';
          state.redirectNotice = true;
        },
      }, icon('external', 18), '立即前往签到'),
      h('div', { class: 'relay-cta-sub' },
        h('button', {
          type: 'button',
          class: 'btn tonal',
          onclick: async () => {
            const ok = await copyText(item.url);
            toast(ok ? '已复制签到链接' : '复制失败，请手动长按链接');
          },
        }, icon('copy', 16), '复制链接'),
        h('button', {
          type: 'button',
          class: 'btn',
          onclick: () => {
            state.senderUrl = item.url;
            if (SOURCES.includes(item.source)) state.senderSource = item.source;
            setMode('send');
          },
        }, '切换到发码'))),
    qrSlot,
    row);

  updateRedirectPromptInPlace();
  updateRecvQrInPlace();
  return card;
}

function syncMainSlot() {
  if (!ui.mainSlot) return;

  if (state.mode === 'send') {
    if (ui.mainKey !== 'send') {
      ui.recv = null;
      clear(ui.mainSlot);
      ui.mainSlot.append(buildSenderCard());
      ui.mainKey = 'send';
    } else {
      updateSenderInPlace();
      updateSenderPreviewInPlace();
    }
    return;
  }

  // recv 模式
  const nextKey = state.active && state.item ? `recv:${state.room}:${state.item.seq}` : 'recv:wait';
  if (ui.mainKey !== nextKey) {
    ui.sender = null;
    clear(ui.mainSlot);
    ui.mainSlot.append(state.active && state.item ? buildReceiverActiveCard() : buildReceiverWaitCard());
    ui.mainKey = nextKey;
  } else {
    updateTtlInPlace();
    updateRedirectPromptInPlace();
    updateRecvQrInPlace();
  }
}

function syncShell() {
  if (!ui.mounted) {
    mountShell();
    return;
  }
  updateStatusChipInPlace();
  updateRoleSwitcherInPlace();
  updateRoomBarInPlace();
  updateTapJumpClass();
  syncMainSlot();
  updatePrewarmInPlace();
}

// ---------- 持久化外壳挂载（仅执行一次） ----------

function mountShell() {
  const root = document.getElementById('root');
  if (!root) return;
  clear(root);

  ui.statusDot = h('span', { class: 'relay-dot' });
  ui.statusText = h('span', { class: 'relay-status-text' }, '连接中');
  ui.statusChip = h('button', {
    type: 'button',
    class: 'sync-chip',
    id: 'relay-status-chip',
    'aria-live': 'polite',
    onclick: () => {
      if (isTapJumpArmed()) {
        tryExecutePendingRedirect({ fromGesture: true });
        return;
      }
      if (!state.online || state.conn === 'offline' || state.conn === 'error') {
        state.online = typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
        restartPolling();
      }
    },
  }, ui.statusDot, ui.statusText);

  const topbar = h('header', { class: 'relay-topbar' },
    h('div', { class: 'relay-brand' },
      h('img', { class: 'relay-logo', src: '/icon.svg', alt: '课堂接力', width: 36, height: 36 }),
      h('div', { class: 'relay-title-col' },
        h('h1', {}, '课堂接力'),
        h('span', { class: 'relay-subtitle' }, 'Class Relay · 微信纯网页版'))),
    ui.statusChip);

  ui.roleSendBtn = h('button', {
    type: 'button',
    class: 'seg-btn',
    'aria-pressed': String(state.mode === 'send'),
    onclick: () => setMode('send'),
  }, '扫码发码');

  ui.roleRecvBtn = h('button', {
    type: 'button',
    class: 'seg-btn',
    'aria-pressed': String(state.mode === 'recv'),
    onclick: () => setMode('recv'),
  }, '收码等待');

  const roleSwitcher = h('div', { class: 'seg mode-switch', role: 'group', 'aria-label': '角色模式' },
    ui.roleSendBtn,
    ui.roleRecvBtn);

  // 紧凑可折叠房间条（默认单行，减少首屏占用）
  ui.roomCodeText = h('span', { class: 'room-code' }, state.room);
  ui.roomQuickCopyBtn = h('button', {
    type: 'button',
    class: 'btn small',
    onclick: async () => {
      const ok = await copyText(buildShareUrl(state.room, 'recv'));
      toast(ok ? '已复制室友收码链接' : '复制失败，请手动复制地址栏');
    },
  }, icon('copy', 15), '复制链接');

  const toggleChevron = icon('down', 16);
  toggleChevron.classList.add('room-toggle-icon');
  ui.roomToggleBtn = h('button', {
    type: 'button',
    class: 'btn small tonal',
    'aria-expanded': 'false',
    'aria-controls': 'room-drawer',
    onclick: () => {
      state.roomBarExpanded = !state.roomBarExpanded;
      updateRoomBarInPlace();
      if (state.roomBarExpanded) {
        ui.roomInput.focus();
        ui.roomInput.select();
      }
    },
  }, '切换', toggleChevron);

  ui.roomInput = h('input', {
    class: 'input room-input',
    value: state.roomDraft,
    maxlength: 32,
    placeholder: '3–32 位字母/数字/_/-',
    'aria-label': '房间口令',
    oninput: (e) => { state.roomDraft = e.target.value; },
  });

  const roomForm = h('form', {
    class: 'room-form',
    onsubmit: (e) => {
      e.preventDefault();
      setRoom(ui.roomInput.value);
    },
  },
    ui.roomInput,
    h('button', {
      type: 'button',
      class: 'icon-btn',
      title: '随机房间号',
      'aria-label': '生成随机房间号',
      onclick: () => setRoom(randomRoomId()),
    }, icon('shuffle', 18)),
    h('button', { type: 'submit', class: 'btn small primary' }, '进入'));

  ui.roomDrawer = h('div', { id: 'room-drawer', class: 'room-drawer', hidden: true },
    roomForm,
    h('div', { class: 'room-links' },
      h('button', {
        type: 'button',
        class: 'btn small',
        onclick: async () => {
          const ok = await copyText(buildShareUrl(state.room, 'recv'));
          toast(ok ? '已复制室友收码链接' : '复制失败，请手动复制地址栏');
        },
      }, icon('copy', 16), '复制收码链接'),
      h('button', {
        type: 'button',
        class: 'btn small',
        onclick: async () => {
          const ok = await copyText(buildShareUrl(state.room, 'send'));
          toast(ok ? '已复制教室发码链接' : '复制失败，请手动复制地址栏');
        },
      }, icon('link', 16), '复制发码链接')));

  ui.roomBar = h('section', { class: 'card room-bar', 'aria-label': '房间设置与分享' },
    h('div', { class: 'room-summary' },
      h('div', { class: 'room-summary-main' },
        h('span', { class: 'room-label' }, '房间'),
        ui.roomCodeText),
      h('div', { class: 'room-summary-actions' },
        ui.roomQuickCopyBtn,
        ui.roomToggleBtn)),
    ui.roomDrawer);

  ui.mainSlot = h('div', { class: 'relay-main-slot' });
  ui.prewarmSlot = h('div', { class: 'relay-prewarm-slot' });

  const footer = h('aside', { class: 'relay-footer-note' },
    '仅在房间内临时转发扫码链接，服务端仅内存暂存并在过期后自动清除。');

  ui.shell = h('div', {
    class: 'relay-shell',
    onclick: (e) => {
      if (!isTapJumpArmed()) return;
      if (e.target instanceof Element && e.target.closest(NON_TAP_JUMP_SELECTOR)) return;
      tryExecutePendingRedirect({ fromGesture: true });
    },
  },
    h('main', { class: 'relay-wrap' },
      topbar,
      roleSwitcher,
      ui.roomBar,
      ui.mainSlot,
      ui.prewarmSlot,
      footer));

  root.append(ui.shell);
  ui.mounted = true;
  syncShell();
}

// ---------- TTL 倒计时（仅在 active && visible 时运行） ----------

function tickTtl() {
  if (!state.active || !state.item) {
    syncTtlTimer();
    return;
  }
  const remain = Math.ceil((state.item.expiresAtLocal - Date.now()) / 1000);
  if (remain <= 0) {
    const wasRecv = state.mode === 'recv';
    clearPendingRedirect();
    state.active = false;
    state.item = null;
    state.redirectNotice = false;
    syncTtlTimer();
    syncMainSlot();
    updateStatusChipInPlace();
    if (wasRecv) {
      toast('签到码已过期，继续等待新码');
    }
    return;
  }
  updateTtlInPlace();
}

function syncTtlTimer() {
  const shouldRun = state.active && state.visible;
  if (shouldRun && !state.ttlTimer) {
    state.ttlTimer = setInterval(tickTtl, 1000);
  } else if (!shouldRun && state.ttlTimer) {
    clearInterval(state.ttlTimer);
    state.ttlTimer = 0;
  }
}

// ---------- 生命周期事件注册 ----------

applyTheme(loadTheme());
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(loadTheme()));
}

window.addEventListener('focus', () => {
  state.focused = true;
  if (state.pendingRedirect && state.redirectStatus === 'awaiting-focus') {
    tryExecutePendingRedirect({ fromGesture: false });
  }
});

window.addEventListener('blur', () => {
  state.focused = false;
  if (state.pendingRedirect && state.redirectStatus === 'idle') {
    state.redirectStatus = 'awaiting-focus';
    ensureQR(state.pendingRedirect.url);
    updateTapJumpClass();
    updateRedirectPromptInPlace();
    updateRecvQrInPlace();
    updateStatusChipInPlace();
  }
});

document.addEventListener('visibilitychange', () => {
  state.visible = document.visibilityState === 'visible';
  if (!state.visible) {
    confirmInFlightRedirect();
    stopPolling();
    syncTtlTimer();
    return;
  }

  state.focused = hasDocumentFocus();
  state.warmed = loadWarmed();
  updatePrewarmInPlace();
  syncTtlTimer();
  tickTtl();
  restartPolling();

  if (state.pendingRedirect && (state.redirectStatus === 'awaiting-focus' || state.redirectStatus === 'idle')) {
    tryExecutePendingRedirect({ fromGesture: false });
  }
});

window.addEventListener('pagehide', () => {
  confirmInFlightRedirect();
  stopPolling();
  syncTtlTimer();
  cleanupScannerInteraction();
  disposeScannerResources();
});

window.addEventListener('pageshow', (e) => {
  clearRedirectWatchdog();
  state.redirectInFlightKey = null;
  state.visible = document.visibilityState === 'visible';
  state.focused = hasDocumentFocus();
  state.online = typeof navigator.onLine === 'boolean' ? navigator.onLine : true;

  if (!e.persisted) return;

  state.warmed = loadWarmed();
  if (state.pendingRedirect && hasRedirectedKey(state.pendingRedirect.key)) {
    state.pendingRedirect = null;
    state.redirectStatus = 'done';
    state.redirectNotice = true;
  } else if (state.item && hasRedirectedKey(redirectedKey(state.item))) {
    state.pendingRedirect = null;
    state.redirectStatus = 'done';
    state.redirectNotice = true;
  }
  if (state.mode === 'recv' && state.active && state.item) {
    ensureQR(state.item.url);
  }
  syncShell();
  syncTtlTimer();
  tickTtl();
  restartPolling();
});

window.addEventListener('offline', () => {
  state.online = false;
  state.conn = 'offline';
  stopPolling();
  updateStatusChipInPlace();
});

window.addEventListener('online', () => {
  state.online = true;
  if (state.visible) {
    restartPolling();
  }
});

// 首次启动：仅挂载一次持久化外壳并启动轮询。
mountShell();
if (state.visible && state.online) {
  restartPolling();
}
