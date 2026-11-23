// 课堂接力 · Class Relay 主入口（纯原生 ES 模块，无构建，严格 CSP）。

import { loadTheme, applyTheme } from './theme.js';
import { h, clear, icon, toast, openDialog } from './dom.js';
import { renderQRDataURL } from './qr.js';
import { extractUrl, decodeImageFile, openCameraScanner } from './scanner.js';

const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;
const STORAGE_ROOM = 'class-relay-room';
const STORAGE_MODE = 'class-relay-mode';
const STORAGE_AUTO = 'class-relay-auto';
const STORAGE_SOURCE = 'class-relay-source';
const STORAGE_TTL = 'class-relay-ttl';
const STORAGE_PRESETS = 'class-relay-prewarm-v1';
const STORAGE_WARMED = 'class-relay-warmed-v1';
const SESSION_REDIRECTED = 'class-relay-redirected';

const SOURCES = ['微助教', '雨课堂', '普通链接'];
const TTLS = [60, 90, 180];

const TEACHERMATE_OAUTH_URL = 'https://open.weixin.qq.com/connect/oauth2/authorize?appid=wxa153455f3ef1d9f9&redirect_uri=https%3A%2F%2Fv18.teachermate.cn%2Fapi%2Fv1%2Fwechat%2Fr%3Fm%3Ds_signin&response_type=code&scope=snsapi_base&state=#wechat_redirect';

const DEFAULT_PRESETS = [
  { id: 'teachermate', name: '微助教', note: '微信静默授权并预热学生签到页', url: TEACHERMATE_OAUTH_URL },
  { id: 'custom', name: '自定义入口', note: '绑定课程或学校统一认证首页', url: '' },
];

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
  return safeReadJSON(localStorage, STORAGE_WARMED, {});
}

function recordWarmed(preset) {
  const warmed = loadWarmed();
  warmed[preset.id] = { name: preset.name, at: Date.now() };
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
  for (const [id, item] of Object.entries(warmed)) {
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

const initRoomVal = initialRoom();
const state = {
  room: initRoomVal,
  roomDraft: initRoomVal,
  mode: initialMode(), // 'send' | 'recv'
  seq: 0,
  active: false,
  item: null,
  qrDataUrl: '',
  qrForUrl: '',
  conn: 'connecting', // 'connecting' | 'live' | 'error'
  autoRedirect: loadAutoRedirect(),
  presets: loadPresets(),
  warmed: loadWarmed(),
  redirectNotice: false,
  pollAbort: null,
  pollRunning: false,
  senderUrl: '',
  senderSource: loadSource(),
  senderTtl: loadTtl(),
  senderBusy: false,
  senderError: '',
};

// 隐藏的图片选择器，供「拍照 / 相册识码」与摄像头弹窗兜底共用。
const fileInput = h('input', {
  type: 'file',
  accept: 'image/*',
  capture: 'environment',
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

function redirectedKey(item) {
  return `${state.room}:${item.seq}:${item.url}`;
}

function hasRedirected(item) {
  try {
    return sessionStorage.getItem(SESSION_REDIRECTED) === redirectedKey(item);
  } catch {
    return false;
  }
}

function markRedirected(item) {
  try {
    sessionStorage.setItem(SESSION_REDIRECTED, redirectedKey(item));
  } catch { /* ignore */ }
}

function setMode(nextMode) {
  if ((nextMode !== 'send' && nextMode !== 'recv') || nextMode === state.mode) return;
  state.mode = nextMode;
  try { localStorage.setItem(STORAGE_MODE, nextMode); } catch { /* ignore */ }
  syncUrl();
  render();
}

function setRoom(nextRoom) {
  const trimmed = nextRoom.trim();
  if (!ROOM_RE.test(trimmed)) {
    toast('房间口令需为 3–32 位字母、数字、_ 或 -');
    return false;
  }
  state.roomDraft = trimmed;
  if (trimmed === state.room) return true;
  state.room = trimmed;
  state.seq = 0;
  state.active = false;
  state.item = null;
  state.qrDataUrl = '';
  state.qrForUrl = '';
  state.redirectNotice = false;
  try { localStorage.setItem(STORAGE_ROOM, trimmed); } catch { /* ignore */ }
  syncUrl();
  restartPolling();
  render();
  toast(`已切换到房间 ${trimmed}`);
  return true;
}

function ensureQR(url) {
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

function updateStatusChipInPlace() {
  const chip = document.getElementById('relay-status-chip');
  if (!chip) return false;
  const dot = chip.querySelector('.relay-dot');
  const txt = chip.querySelector('.relay-status-text');
  if (!dot || !txt) return false;
  const dotCls = state.active ? 'active' : state.conn === 'live' ? 'live' : state.conn === 'error' ? 'err' : '';
  dot.className = `relay-dot ${dotCls}`.trim();
  txt.textContent = state.active ? '已收到新码' : state.conn === 'live' ? '实时等待中' : state.conn === 'error' ? '重连中' : '连接中';
  return true;
}

function applyPayload(data) {
  const prevActive = state.active;
  const prevSeq = state.item ? state.item.seq : 0;
  const prevConn = state.conn;

  state.conn = 'live';
  state.seq = typeof data.seq === 'number' ? data.seq : state.seq;

  if (!data.active || !data.url) {
    state.active = false;
    state.item = null;
    state.redirectNotice = false;
    if (prevActive) render();
    else if (prevConn !== 'live' && !updateStatusChipInPlace()) render();
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
  const isNewKey = !hasRedirected(item);
  state.active = true;
  state.item = item;
  state.redirectNotice = !isNewKey;
  ensureQR(item.url);

  if (!prevActive || prevSeq !== item.seq) {
    render();
  } else if (prevConn !== 'live' && !updateStatusChipInPlace()) {
    render();
  }

  if (state.mode === 'recv' && state.autoRedirect && isNewKey && document.visibilityState === 'visible') {
    markRedirected(item);
    setTimeout(() => {
      if (state.mode === 'recv' && state.active && state.item && state.item.seq === item.seq) {
        window.location.href = item.url;
      }
    }, 120);
  }
}

async function pollOnce(waitSec) {
  if (state.pollAbort) state.pollAbort.abort();
  const ac = new AbortController();
  state.pollAbort = ac;
  const url = `/api/v1/relay/${encodeURIComponent(state.room)}?since=${state.seq}&wait=${waitSec}`;
  const resp = await fetch(url, { signal: ac.signal, cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function runPollLoop(immediateFirst) {
  if (state.pollRunning) return;
  state.pollRunning = true;
  let first = immediateFirst;
  while (state.pollRunning) {
    if (document.visibilityState === 'hidden') {
      state.pollRunning = false;
      return;
    }
    try {
      const waitSec = first ? 0 : 15;
      first = false;
      const data = await pollOnce(waitSec);
      applyPayload(data);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (!state.pollRunning) return;
        first = true;
        continue;
      }
      state.conn = 'error';
      if (!updateStatusChipInPlace()) render();
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

function restartPolling() {
  if (state.pollAbort) state.pollAbort.abort();
  state.pollRunning = false;
  state.conn = 'connecting';
  if (!updateStatusChipInPlace()) render();
  runPollLoop(true);
}

// ---------- 发码端逻辑 ----------

async function pushUrl(rawUrl, sourceOverride) {
  const url = extractUrl(rawUrl);
  if (!url) {
    state.senderError = '未识别到合法的 http:// 或 https:// 链接';
    render();
    return false;
  }
  const source = sourceOverride || guessSource(url, state.senderSource);
  state.senderSource = source;
  try { localStorage.setItem(STORAGE_SOURCE, source); } catch { /* ignore */ }

  state.senderBusy = true;
  state.senderError = '';
  render();

  try {
    const resp = await fetch(`/api/v1/relay/${encodeURIComponent(state.room)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, source, ttlSec: state.senderTtl }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || `HTTP ${resp.status}`);
    state.senderUrl = url;
    applyPayload({
      active: true,
      seq: data.seq,
      url: data.url || url,
      source: data.source || source,
      host: data.host || '',
      expiresAt: data.expiresAt,
      serverTime: data.serverTime,
    });
    toast(`已发送到房间 ${state.room}`);
    return true;
  } catch (err) {
    state.senderError = (err && err.message) || '发送失败，请稍后重试';
    toast(state.senderError);
    return false;
  } finally {
    state.senderBusy = false;
    render();
  }
}

async function handleScannedText(rawText) {
  const text = String(rawText || '').trim();
  const url = extractUrl(text);
  if (!url) {
    state.senderUrl = text;
    state.senderError = '二维码内容不包含 http(s):// 链接，已填入下方文本框供核对';
    render();
    toast('未识别到网址，请检查二维码内容');
    return;
  }
  state.senderUrl = url;
  await pushUrl(url, guessSource(url, state.senderSource));
}

function getScanCapability() {
  const hasCamera = Boolean(
    navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function',
  );
  if (hasCamera) {
    return {
      ready: true,
      label: 'Web 相机扫码就绪（支持微信内直接扫码与拍照识码）',
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
  openCameraScanner({
    onResult: (text) => { handleScannedText(text); },
    onPickFile: () => { fileInput.click(); },
  });
}

async function handleImageFile(file) {
  state.senderBusy = true;
  state.senderError = '';
  render();
  try {
    const text = await decodeImageFile(file);
    state.senderBusy = false;
    await handleScannedText(text);
  } catch (err) {
    state.senderBusy = false;
    state.senderError = (err && err.message) || '图片识码失败';
    toast(state.senderError);
    render();
  }
}

async function handlePasteOrExtract() {
  const existing = extractUrl(state.senderUrl);
  if (existing && existing !== state.senderUrl.trim()) {
    state.senderUrl = existing;
    state.senderError = '';
    render();
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
        render();
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
    state.active = false;
    state.item = null;
    state.redirectNotice = false;
    render();
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
  const errEl = h('p', { class: 'form-error', hidden: true });
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
      render();
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
  state.warmed = loadWarmed();
  window.location.href = preset.url;
}

// ---------- 视图渲染 ----------

function renderStatusChip() {
  const dotCls = state.active ? 'active' : state.conn === 'live' ? 'live' : state.conn === 'error' ? 'err' : '';
  const text = state.active ? '已收到新码' : state.conn === 'live' ? '实时等待中' : state.conn === 'error' ? '重连中' : '连接中';
  return h('div', { class: 'sync-chip', id: 'relay-status-chip', 'aria-live': 'polite' },
    h('span', { class: `relay-dot ${dotCls}`.trim() }),
    h('span', { class: 'relay-status-text' }, text));
}

function renderRoleSwitcher() {
  return h('div', { class: 'seg mode-switch', role: 'tablist', 'aria-label': '角色模式' },
    h('button', {
      type: 'button',
      class: 'seg-btn',
      role: 'tab',
      'aria-pressed': String(state.mode === 'send'),
      'aria-selected': String(state.mode === 'send'),
      onclick: () => setMode('send'),
    }, '扫码发码'),
    h('button', {
      type: 'button',
      class: 'seg-btn',
      role: 'tab',
      'aria-pressed': String(state.mode === 'recv'),
      'aria-selected': String(state.mode === 'recv'),
      onclick: () => setMode('recv'),
    }, '收码等待'));
}

function renderRoomBar() {
  const roomInput = h('input', {
    class: 'input room-input',
    value: state.roomDraft,
    maxlength: 32,
    placeholder: '3–32 位字母/数字/_/-',
    'aria-label': '房间口令',
    oninput: (e) => { state.roomDraft = e.target.value; },
  });

  const form = h('form', {
    class: 'room-form',
    onsubmit: (e) => {
      e.preventDefault();
      setRoom(roomInput.value);
    },
  },
    h('span', { class: 'room-label' }, '房间'),
    roomInput,
    h('button', {
      type: 'button',
      class: 'icon-btn',
      title: '随机房间号',
      'aria-label': '生成随机房间号',
      onclick: () => setRoom(randomRoomId()),
    }, icon('shuffle', 18)),
    h('button', { type: 'submit', class: 'btn small tonal' }, '切换'));

  return h('section', { class: 'card room-bar', 'aria-label': '房间设置与分享' },
    form,
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
}

function renderActivePreview() {
  if (!state.active || !state.item) return null;
  const { item } = state;
  const remain = Math.max(0, Math.ceil((item.expiresAtLocal - Date.now()) / 1000));
  return h('div', { class: 'sender-preview' },
    h('div', { class: 'relay-active-head' },
      h('div', { class: 'relay-badges' },
        h('span', { class: 'relay-pill' }, item.source),
        h('span', { class: 'relay-pill ttl', id: 'relay-ttl' }, `${remain}s 后过期`)),
      h('button', { type: 'button', class: 'btn small danger-ghost', onclick: clearActiveItem }, '清除')),
    h('div', { class: 'stack-sm' },
      h('b', {}, item.host || '当前房间有效链接'),
      h('p', { class: 'relay-url' }, item.url)));
}

function renderSenderCard() {
  const scanCap = getScanCapability();
  const badgeCls = scanCap.ready ? 'ready' : 'warn';
  const urlInput = h('textarea', {
    class: 'input relay-tonal-input',
    value: state.senderUrl,
    placeholder: '粘贴包含 http(s):// 的签到链接或文本',
    oninput: (e) => {
      state.senderUrl = e.target.value;
      state.senderError = '';
    },
  });

  const sourceGroup = h('div', { class: 'seg', role: 'group', 'aria-label': '来源平台' },
    ...SOURCES.map((s) => h('button', {
      type: 'button',
      class: 'seg-btn',
      'aria-pressed': String(s === state.senderSource),
      onclick: () => {
        state.senderSource = s;
        try { localStorage.setItem(STORAGE_SOURCE, s); } catch { /* ignore */ }
        render();
      },
    }, s)));

  const ttlGroup = h('div', { class: 'seg', role: 'group', 'aria-label': '有效时长' },
    ...TTLS.map((t) => h('button', {
      type: 'button',
      class: 'seg-btn',
      'aria-pressed': String(t === state.senderTtl),
      onclick: () => {
        state.senderTtl = t;
        try { localStorage.setItem(STORAGE_TTL, String(t)); } catch { /* ignore */ }
        render();
      },
    }, `${t} 秒`)));

  const pasteForm = h('form', {
    class: 'sender-form',
    onsubmit: async (e) => {
      e.preventDefault();
      await pushUrl(state.senderUrl, state.senderSource);
    },
  },
    h('div', { class: 'field' },
      h('div', { class: 'field-head' },
        h('span', { class: 'field-label' }, '粘贴链接发送'),
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
    state.senderError ? h('p', { class: 'form-error' }, state.senderError) : null,
    h('div', { class: 'sender-form-actions' },
      h('button', {
        type: 'submit',
        class: 'btn primary',
        disabled: state.senderBusy,
      }, icon('send', 18), state.senderBusy ? '发送中…' : '推送到房间'),
      h('button', {
        type: 'button',
        class: 'btn danger-ghost',
        disabled: !state.active,
        onclick: clearActiveItem,
      }, icon('trash', 18), '清除')));

  return h('section', { class: 'card relay-card' },
    h('div', { class: `scan-badge ${badgeCls}` },
      h('span', { class: `relay-dot ${scanCap.ready ? 'live' : ''}`.trim() }),
      h('span', {}, scanCap.label)),
    h('div', { class: 'sender-scan-actions' },
      h('button', {
        type: 'button',
        class: 'btn primary hero',
        disabled: state.senderBusy,
        onclick: handlePrimaryScan,
      }, icon('scan', 22), '扫一扫并发送'),
      h('button', {
        type: 'button',
        class: 'btn tonal wide-btn',
        disabled: state.senderBusy,
        onclick: () => fileInput.click(),
      }, icon('image', 18), '拍照 / 相册识码')),
    renderActivePreview(),
    h('div', { class: 'sender-divider' }, '或手动粘贴链接'),
    pasteForm);
}

function renderReceiverCard() {
  const switchRow = h('div', { class: 'relay-switch-row' },
    h('div', { class: 'relay-switch-text' },
      h('b', {}, '收到新码自动跳转'),
      h('span', {}, '使用 location.href，保留微信左上角返回键')),
    h('button', {
      type: 'button',
      class: 'relay-switch',
      role: 'switch',
      'aria-checked': String(state.autoRedirect),
      'aria-label': '收到新码自动跳转',
      onclick: () => {
        state.autoRedirect = !state.autoRedirect;
        saveAutoRedirect(state.autoRedirect);
        render();
      },
    }));

  if (!state.active || !state.item) {
    return h('section', { class: 'card relay-card' },
      h('div', { class: 'relay-wait' },
        h('div', { class: 'relay-emblem' }, icon('sparkle', 28)),
        h('h2', {}, '等待教室端传码'),
        h('p', {}, '建议将本页设为微信「浮窗」，收到通知点回即可接力签到')),
      switchRow);
  }

  const { item } = state;
  const remain = Math.max(0, Math.ceil((item.expiresAtLocal - Date.now()) / 1000));
  const qrImg = state.qrDataUrl
    ? h('div', { class: 'relay-qr-wrap' },
        h('img', { class: 'relay-qr-img', src: state.qrDataUrl, alt: '兜底签到二维码' }),
        h('p', { class: 'hint center' }, '若自动跳转被拦截，可长按二维码识别'))
    : null;

  return h('section', { class: 'card relay-card' },
    h('div', { class: 'relay-active-head' },
      h('div', { class: 'relay-badges' },
        h('span', { class: 'relay-pill' }, item.source),
        h('span', { class: 'relay-pill ttl', id: 'relay-ttl' }, `${remain}s 后过期`)),
      h('button', { type: 'button', class: 'btn small ghost', onclick: clearActiveItem }, '清除')),
    h('div', { class: 'stack-sm' },
      h('h2', { class: 'relay-host' }, item.host || '签到链接已就绪'),
      h('p', { class: 'relay-url' }, item.url)),
    state.redirectNotice
      ? h('p', { class: 'relay-notice' }, '本条链接已自动跳转过；如需再次打开，请点击下方按钮或长按二维码。')
      : null,
    h('div', { class: 'relay-cta-col' },
      h('a', {
        class: 'btn primary wide-btn',
        href: item.url,
        onclick: () => markRedirected(item),
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
    qrImg,
    switchRow);
}

function renderPrewarmSection() {
  state.warmed = loadWarmed();
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

  return h('section', { class: 'relay-section' },
    h('div', { class: 'relay-section-head' },
      h('span', { class: 'relay-section-title' }, '课前预热'),
      h('span', { class: 'relay-section-status' }, latestWarmedSummary(state.warmed))),
    h('div', { class: 'relay-prewarm-list' }, ...rows));
}

function render() {
  const root = document.getElementById('root');
  if (!root) return;
  clear(root);

  const topbar = h('header', { class: 'relay-topbar' },
    h('div', { class: 'relay-brand' },
      h('img', { class: 'relay-logo', src: '/icon.svg', alt: '课堂接力', width: 36, height: 36 }),
      h('div', { class: 'relay-title-col' },
        h('h1', {}, '课堂接力'),
        h('span', { class: 'relay-subtitle' }, 'Class Relay · 微信纯网页版'))),
    renderStatusChip());

  const mainChildren = [
    topbar,
    renderRoleSwitcher(),
    renderRoomBar(),
    state.mode === 'send' ? renderSenderCard() : renderReceiverCard(),
  ];

  if (state.mode === 'recv') {
    mainChildren.push(renderPrewarmSection());
  }

  mainChildren.push(h('aside', { class: 'relay-footer-note' },
    '仅在房间内临时转发扫码链接，服务端仅内存暂存并在过期后自动清除。'));

  root.append(h('div', { class: 'relay-shell' },
    h('main', { class: 'relay-wrap' }, ...mainChildren)));
}

// ---------- 生命周期与定时刷新 ----------

applyTheme(loadTheme());
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(loadTheme()));
}

setInterval(() => {
  if (!state.active || !state.item) return;
  const remain = Math.ceil((state.item.expiresAtLocal - Date.now()) / 1000);
  if (remain <= 0) {
    state.active = false;
    state.item = null;
    state.redirectNotice = false;
    render();
    return;
  }
  const el = document.getElementById('relay-ttl');
  if (el) el.textContent = `${remain}s 后过期`;
}, 1000);

function resumeFromBackground() {
  if (document.visibilityState === 'visible') {
    state.warmed = loadWarmed();
    restartPolling();
  } else if (state.pollAbort) {
    state.pollAbort.abort();
    state.pollRunning = false;
  }
}

document.addEventListener('visibilitychange', resumeFromBackground);
window.addEventListener('pageshow', (e) => {
  if (e.persisted) resumeFromBackground();
  else render();
});

render();
runPollLoop(true);
