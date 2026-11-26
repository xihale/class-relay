import { signal, type ReadonlySignal } from '@preact/signals';
import type {
  ConnectionStatus,
  RelayItem,
  RelaySnapshot,
  Role,
  RoomPeers,
  RoomReceipts,
  TransportKind,
} from '../types/protocol';
import { getClientId } from './storage';

const WS_CONNECT_TIMEOUT_MS = 2500;
const WS_PING_INTERVAL_MS = 15000;
const WS_PONG_TIMEOUT_MS = 4000;
const WS_WAKEUP_TIMEOUT_MS = 800;
const WS_REQ_TIMEOUT_MS = 5000;
const WS_MAX_FAILURES = 2;
const WS_RETRY_DELAY_MS = 600;
const WS_UPGRADE_INTERVAL_MS = 60000;
const SSE_WATCHDOG_MS = 25000;
const POLL_BACKOFF_MS = [1500, 3000, 6000, 10000];

export interface RelayTransport {
  readonly status: ReadonlySignal<ConnectionStatus>;
  readonly transport: ReadonlySignal<TransportKind>;
  readonly rttMs: ReadonlySignal<number | null>;
  readonly errorText: ReadonlySignal<string>;
  readonly peers: ReadonlySignal<RoomPeers>;
  readonly receipts: ReadonlySignal<RoomReceipts>;
  readonly activeItem: ReadonlySignal<RelayItem | null>;
  readonly seq: ReadonlySignal<number>;
  readonly clockOffsetMs: ReadonlySignal<number>;
  connect(room: string, role: Role): void;
  setRole(role: Role): void;
  disconnect(): void;
  reconnect(): void;
  probeWakeup(): void;
  push(input: { url: string; source: string; ttlSec: number }): Promise<RelaySnapshot>;
  clear(): Promise<RelaySnapshot>;
  sendReceipt(seq: number, kind: 'delivered' | 'jumped'): void;
  onSnapshot(cb: (snap: RelaySnapshot, item: RelayItem | null) => void): () => void;
}

interface PendingReq {
  resolve: (snap: RelaySnapshot) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function sleepAbortable(ms: number, sig: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sig.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(tid);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const tid = setTimeout(() => {
      sig.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    sig.addEventListener('abort', onAbort, { once: true });
  });
}

function buildWsUrl(room: string, role: Role, since: number, cid: string): string {
  const proto =
    typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' && location.host ? location.host : 'localhost';
  return `${proto}//${host}/api/v1/relay/${encodeURIComponent(room)}/ws?role=${encodeURIComponent(role)}&since=${since}&cid=${encodeURIComponent(cid)}`;
}

function buildSseUrl(room: string, role: Role, since: number, cid: string): string {
  return `/api/v1/relay/${encodeURIComponent(room)}/events?role=${encodeURIComponent(role)}&since=${since}&cid=${encodeURIComponent(cid)}`;
}

export function createRelayTransport(): RelayTransport {
  const statusSig = signal<ConnectionStatus>('connecting');
  const transportSig = signal<TransportKind>('ws');
  const rttMsSig = signal<number | null>(null);
  const errorTextSig = signal<string>('');
  const peersSig = signal<RoomPeers>({ total: 0, recv: 0, send: 0 });
  const receiptsSig = signal<RoomReceipts>({ delivered: 0, jumped: 0 });
  const activeItemSig = signal<RelayItem | null>(null);
  const seqSig = signal<number>(0);
  const clockOffsetMsSig = signal<number>(0);

  const cid = getClientId();
  const listeners = new Set<(snap: RelaySnapshot, item: RelayItem | null) => void>();

  let currentRoom = '';
  let currentRole: Role = 'recv';
  let active = false;
  let connGen = 0;

  // WebSocket state
  let ws: WebSocket | null = null;
  let wsFailures = 0;
  let wsConnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsPingInterval: ReturnType<typeof setInterval> | null = null;
  let wsPongTimer: ReturnType<typeof setTimeout> | null = null;
  let wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let wsUpgradeTimer: ReturnType<typeof setInterval> | null = null;
  let pingSentAt = 0;
  let reqSeq = 0;
  const pendingReqs = new Map<string, PendingReq>();

  // SSE state
  let es: EventSource | null = null;
  let sseWatchdog: ReturnType<typeof setTimeout> | null = null;
  let sseErrors = 0;

  // Long-Poll state
  let pollGen = 0;
  let pollAbort: AbortController | null = null;

  function isOnline(): boolean {
    return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean'
      ? true
      : navigator.onLine;
  }

  function clearWsTimers(): void {
    if (wsConnectTimer !== null) {
      clearTimeout(wsConnectTimer);
      wsConnectTimer = null;
    }
    if (wsPingInterval !== null) {
      clearInterval(wsPingInterval);
      wsPingInterval = null;
    }
    if (wsPongTimer !== null) {
      clearTimeout(wsPongTimer);
      wsPongTimer = null;
    }
    if (wsRetryTimer !== null) {
      clearTimeout(wsRetryTimer);
      wsRetryTimer = null;
    }
  }

  function clearUpgradeTimer(): void {
    if (wsUpgradeTimer !== null) {
      clearInterval(wsUpgradeTimer);
      wsUpgradeTimer = null;
    }
  }

  function clearSseWatchdog(): void {
    if (sseWatchdog !== null) {
      clearTimeout(sseWatchdog);
      sseWatchdog = null;
    }
  }

  function rejectAllPendingReqs(reason: string): void {
    const err = new Error(reason);
    for (const [id, req] of pendingReqs) {
      clearTimeout(req.timer);
      req.reject(err);
      pendingReqs.delete(id);
    }
  }

  function closeWs(): void {
    clearWsTimers();
    if (ws) {
      const sock = ws;
      ws = null;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try {
        sock.close();
      } catch {
        // ignore
      }
    }
    rejectAllPendingReqs('WebSocket closed');
  }

  function closeSse(): void {
    clearSseWatchdog();
    if (es) {
      const src = es;
      es = null;
      src.onopen = null;
      src.onerror = null;
      src.onmessage = null;
      try {
        src.close();
      } catch {
        // ignore
      }
    }
  }

  function stopPoll(): void {
    pollGen++;
    if (pollAbort) {
      pollAbort.abort();
      pollAbort = null;
    }
  }

  function teardownAllTransports(): void {
    closeWs();
    closeSse();
    stopPoll();
    clearUpgradeTimer();
  }

  function normalizeItem(snap: RelaySnapshot, offsetMs: number): RelayItem | null {
    if (!snap.active || !snap.url) return null;
    const now = Date.now();
    const createdAt = typeof snap.createdAt === 'number' ? snap.createdAt : now;
    const expiresAt = typeof snap.expiresAt === 'number' ? snap.expiresAt : now + 90000;
    return {
      seq: snap.seq,
      room: snap.room || currentRoom,
      url: snap.url,
      source: snap.source || '课堂链接',
      host: snap.host || '',
      createdAt,
      expiresAt,
      expiresAtLocal: expiresAt - offsetMs,
    };
  }

  function applySnapshot(raw: RelaySnapshot): RelayItem | null {
    if (!raw || (raw.room && currentRoom && raw.room !== currentRoom)) {
      return activeItemSig.value;
    }

    const offsetMs =
      typeof raw.serverTime === 'number' && Number.isFinite(raw.serverTime)
        ? raw.serverTime - Date.now()
        : clockOffsetMsSig.value;
    clockOffsetMsSig.value = offsetMs;

    if (typeof raw.seq === 'number') {
      seqSig.value = raw.seq;
    }
    if (raw.peers) {
      peersSig.value = {
        total: Number(raw.peers.total) || 0,
        recv: Number(raw.peers.recv) || 0,
        send: Number(raw.peers.send) || 0,
      };
    }
    if (raw.receipts) {
      receiptsSig.value = {
        delivered: Number(raw.receipts.delivered) || 0,
        jumped: Number(raw.receipts.jumped) || 0,
      };
    }

    const item = normalizeItem(raw, offsetMs);
    activeItemSig.value = item;
    statusSig.value = 'live';
    errorTextSig.value = '';

    for (const cb of listeners) {
      try {
        cb(raw, item);
      } catch {
        // ignore listener errors
      }
    }
    return item;
  }

  function scheduleWsUpgrade(): void {
    if (wsUpgradeTimer !== null || typeof globalThis.WebSocket !== 'function') return;
    wsUpgradeTimer = setInterval(() => {
      if (!active || !currentRoom || !isOnline()) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (transportSig.value !== 'ws') {
        wsFailures = 0;
        startWs(++connGen);
      }
    }, WS_UPGRADE_INTERVAL_MS);
  }

  function sendWsPing(timeoutMs: number): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (wsPongTimer !== null) {
      clearTimeout(wsPongTimer);
      wsPongTimer = null;
    }
    pingSentAt = Date.now();
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch {
      handleWsDrop(connGen, 'WS ping failed');
      return;
    }
    const myGen = connGen;
    wsPongTimer = setTimeout(() => {
      wsPongTimer = null;
      if (active && myGen === connGen) {
        handleWsDrop(myGen, 'WS pong timeout');
      }
    }, timeoutMs);
  }

  function handleWsDrop(myGen: number, reason: string): void {
    if (!active || myGen !== connGen) return;
    closeWs();
    if (!isOnline()) {
      statusSig.value = 'offline';
      errorTextSig.value = '网络已断开';
      return;
    }
    wsFailures++;
    errorTextSig.value = reason;
    if (wsFailures >= WS_MAX_FAILURES) {
      if (typeof globalThis.EventSource === 'function') {
        startSse(myGen);
      } else {
        startPoll(myGen);
      }
      return;
    }
    statusSig.value = 'reconnecting';
    wsRetryTimer = setTimeout(() => {
      wsRetryTimer = null;
      if (active && myGen === connGen) {
        startWs(myGen);
      }
    }, WS_RETRY_DELAY_MS);
  }

  function startWs(myGen: number): void {
    if (!active || myGen !== connGen) return;
    closeWs();
    closeSse();
    stopPoll();

    if (!isOnline()) {
      statusSig.value = 'offline';
      return;
    }

    if (typeof globalThis.WebSocket !== 'function') {
      if (typeof globalThis.EventSource === 'function') {
        startSse(myGen);
      } else {
        startPoll(myGen);
      }
      return;
    }

    transportSig.value = 'ws';
    statusSig.value = wsFailures > 0 ? 'reconnecting' : 'connecting';

    let sock: WebSocket;
    try {
      sock = new WebSocket(buildWsUrl(currentRoom, currentRole, seqSig.value, cid));
    } catch {
      handleWsDrop(myGen, 'WebSocket 不可用');
      return;
    }
    ws = sock;

    wsConnectTimer = setTimeout(() => {
      wsConnectTimer = null;
      if (ws === sock && sock.readyState !== WebSocket.OPEN) {
        handleWsDrop(myGen, 'WS 连接超时');
      }
    }, WS_CONNECT_TIMEOUT_MS);

    sock.onopen = () => {
      if (ws !== sock || !active || myGen !== connGen) return;
      if (wsConnectTimer !== null) {
        clearTimeout(wsConnectTimer);
        wsConnectTimer = null;
      }
      clearUpgradeTimer();
      wsFailures = 0;
      transportSig.value = 'ws';
      statusSig.value = 'live';
      errorTextSig.value = '';

      wsPingInterval = setInterval(() => {
        if (ws === sock && sock.readyState === WebSocket.OPEN) {
          sendWsPing(WS_PONG_TIMEOUT_MS);
        }
      }, WS_PING_INTERVAL_MS);
    };

    sock.onmessage = (event: MessageEvent) => {
      if (ws !== sock || !active || myGen !== connGen) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const type = msg.type;
      if (type === 'pong') {
        if (wsPongTimer !== null) {
          clearTimeout(wsPongTimer);
          wsPongTimer = null;
        }
        if (pingSentAt > 0) {
          rttMsSig.value = Math.max(0, Date.now() - pingSentAt);
        }
        if (typeof msg.serverTime === 'number') {
          clockOffsetMsSig.value = msg.serverTime - Date.now();
        }
        return;
      }
      if (type === 'state') {
        const snap = (
          msg.state && typeof msg.state === 'object' ? msg.state : msg
        ) as RelaySnapshot;
        applySnapshot(snap);
        return;
      }
      if (type === 'ack_push') {
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        const pending = pendingReqs.get(reqId);
        if (!pending) return;
        pendingReqs.delete(reqId);
        clearTimeout(pending.timer);
        if (msg.ok && msg.state && typeof msg.state === 'object') {
          const snap = msg.state as RelaySnapshot;
          applySnapshot(snap);
          pending.resolve(snap);
        } else {
          pending.reject(
            new Error(String(msg.message || msg.error || '操作失败')),
          );
        }
      }
    };

    sock.onerror = () => {
      if (ws !== sock || !active || myGen !== connGen) return;
      handleWsDrop(myGen, 'WS 连接异常');
    };

    sock.onclose = () => {
      if (ws !== sock || !active || myGen !== connGen) return;
      handleWsDrop(myGen, 'WS 连接断开');
    };
  }

  function resetSseWatchdog(myGen: number): void {
    clearSseWatchdog();
    sseWatchdog = setTimeout(() => {
      sseWatchdog = null;
      if (active && myGen === connGen && transportSig.value === 'sse') {
        closeSse();
        startPoll(myGen);
      }
    }, SSE_WATCHDOG_MS);
  }

  function startSse(myGen: number): void {
    if (!active || myGen !== connGen) return;
    closeWs();
    closeSse();
    stopPoll();

    if (!isOnline()) {
      statusSig.value = 'offline';
      return;
    }

    if (typeof globalThis.EventSource !== 'function') {
      startPoll(myGen);
      return;
    }

    transportSig.value = 'sse';
    statusSig.value = 'reconnecting';
    rttMsSig.value = null;
    sseErrors = 0;
    scheduleWsUpgrade();

    let src: EventSource;
    try {
      src = new EventSource(buildSseUrl(currentRoom, currentRole, seqSig.value, cid));
    } catch {
      startPoll(myGen);
      return;
    }
    es = src;
    resetSseWatchdog(myGen);

    const handleStateData = (raw: string) => {
      if (es !== src || !active || myGen !== connGen) return;
      resetSseWatchdog(myGen);
      try {
        const snap = JSON.parse(raw) as RelaySnapshot;
        applySnapshot(snap);
      } catch {
        // ignore malformed event
      }
    };

    src.onopen = () => {
      if (es !== src || !active || myGen !== connGen) return;
      sseErrors = 0;
      statusSig.value = 'live';
      errorTextSig.value = '';
      resetSseWatchdog(myGen);
    };

    src.addEventListener('state', (ev: Event) => {
      handleStateData(String((ev as MessageEvent).data || ''));
    });

    src.onmessage = (ev: MessageEvent) => {
      handleStateData(String(ev.data || ''));
    };

    src.onerror = () => {
      if (es !== src || !active || myGen !== connGen) return;
      sseErrors++;
      if (src.readyState === EventSource.CLOSED || sseErrors >= 2) {
        closeSse();
        startPoll(myGen);
      } else {
        statusSig.value = 'reconnecting';
      }
    };
  }

  function startPoll(myGen: number): void {
    if (!active || myGen !== connGen) return;
    closeWs();
    closeSse();
    stopPoll();

    if (!isOnline()) {
      statusSig.value = 'offline';
      return;
    }

    transportSig.value = 'poll';
    statusSig.value = 'reconnecting';
    rttMsSig.value = null;
    scheduleWsUpgrade();

    const myPollGen = ++pollGen;
    void runPollLoop(myGen, myPollGen);
  }

  async function runPollLoop(myConnGen: number, myPollGen: number): Promise<void> {
    let first = true;
    let attempt = 0;

    while (active && myConnGen === connGen && myPollGen === pollGen) {
      if (!isOnline()) {
        statusSig.value = 'offline';
        return;
      }

      const ac = new AbortController();
      pollAbort = ac;
      const waitSec = first ? 0 : 15;
      const room = currentRoom;
      const url = `/api/v1/relay/${encodeURIComponent(room)}?since=${seqSig.value}&wait=${waitSec}`;

      try {
        const resp = await fetch(url, { signal: ac.signal, cache: 'no-store' });
        if (!resp.ok) {
          const err = new Error(`HTTP ${resp.status}`) as Error & {
            status?: number;
            retryAfterMs?: number;
          };
          err.status = resp.status;
          const ra = resp.headers?.get?.('Retry-After');
          if (ra) {
            const sec = Number(ra);
            if (Number.isFinite(sec) && sec > 0) err.retryAfterMs = sec * 1000;
          }
          throw err;
        }
        const snap = (await resp.json()) as RelaySnapshot;
        if (!active || myConnGen !== connGen || myPollGen !== pollGen) return;
        first = false;
        attempt = 0;
        applySnapshot(snap);
      } catch (err) {
        if (!active || myConnGen !== connGen || myPollGen !== pollGen) return;
        if (err && (err as { name?: string }).name === 'AbortError') return;

        const httpErr = err as Error & { status?: number; retryAfterMs?: number };
        const baseDelay = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)];
        const jitter = Math.floor(Math.random() * 400);
        let delay = baseDelay + jitter;
        if (httpErr.status === 429) {
          delay = Math.max(httpErr.retryAfterMs || 0, delay * 2, 5000);
          errorTextSig.value = '请求过于频繁，稍后重试';
        } else {
          errorTextSig.value = httpErr.message || '连接中断';
        }
        attempt++;
        statusSig.value = isOnline() ? 'reconnecting' : 'offline';

        const retryAc = new AbortController();
        pollAbort = retryAc;
        try {
          await sleepAbortable(delay, retryAc.signal);
        } catch {
          return;
        }
      }
    }
  }

  function sendWsRequest(payload: Record<string, unknown>): Promise<RelaySnapshot> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WS not open'));
        return;
      }
      const reqId = `r${++reqSeq}_${Date.now()}`;
      const timer = setTimeout(() => {
        pendingReqs.delete(reqId);
        reject(new Error('WS request timeout'));
      }, WS_REQ_TIMEOUT_MS);

      pendingReqs.set(reqId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ ...payload, reqId }));
      } catch (err) {
        clearTimeout(timer);
        pendingReqs.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async function pushRest(input: {
    url: string;
    source: string;
    ttlSec: number;
  }): Promise<RelaySnapshot> {
    const resp = await fetch(`/api/v1/relay/${encodeURIComponent(currentRoom)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: input.url,
        source: input.source,
        ttlSec: input.ttlSec,
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as RelaySnapshot & {
      message?: string;
      error?: string;
    };
    if (!resp.ok) {
      throw new Error(data.message || data.error || `HTTP ${resp.status}`);
    }
    applySnapshot(data);
    return data;
  }

  async function clearRest(): Promise<RelaySnapshot> {
    const resp = await fetch(`/api/v1/relay/${encodeURIComponent(currentRoom)}`, {
      method: 'DELETE',
    });
    const data = (await resp.json().catch(() => ({}))) as RelaySnapshot & {
      message?: string;
      error?: string;
    };
    if (!resp.ok) {
      throw new Error(data.message || data.error || `HTTP ${resp.status}`);
    }
    applySnapshot(data);
    return data;
  }

  const onOnline = () => {
    if (!active || !currentRoom) return;
    reconnect();
  };

  const onOffline = () => {
    if (!active) return;
    teardownAllTransports();
    statusSig.value = 'offline';
    errorTextSig.value = '网络已断开';
  };

  let netListenersBound = false;
  function bindNetListeners(): void {
    if (netListenersBound || typeof window === 'undefined') return;
    netListenersBound = true;
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }

  function unbindNetListeners(): void {
    if (!netListenersBound || typeof window === 'undefined') return;
    netListenersBound = false;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  }

  function connect(room: string, role: Role): void {
    const roomChanged = room !== currentRoom;
    currentRoom = room;
    currentRole = role;
    active = true;
    if (roomChanged) {
      seqSig.value = 0;
      activeItemSig.value = null;
      peersSig.value = { total: 0, recv: 0, send: 0 };
      receiptsSig.value = { delivered: 0, jumped: 0 };
      rttMsSig.value = null;
    }
    wsFailures = 0;
    bindNetListeners();
    startWs(++connGen);
  }

  function setRole(role: Role): void {
    if (currentRole === role) return;
    currentRole = role;
    if (!active || !currentRoom) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'role', role }));
        return;
      } catch {
        // fall through to reconnect
      }
    }
    if (transportSig.value === 'sse') {
      startSse(++connGen);
    }
  }

  function disconnect(): void {
    active = false;
    connGen++;
    teardownAllTransports();
    unbindNetListeners();
  }

  function reconnect(): void {
    if (!currentRoom) return;
    active = true;
    wsFailures = 0;
    bindNetListeners();
    startWs(++connGen);
  }

  function probeWakeup(): void {
    if (!active || !currentRoom) return;
    if (!isOnline()) {
      statusSig.value = 'offline';
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWsPing(WS_WAKEUP_TIMEOUT_MS);
    } else {
      reconnect();
    }
  }

  async function push(input: {
    url: string;
    source: string;
    ttlSec: number;
  }): Promise<RelaySnapshot> {
    if (!currentRoom) throw new Error('未连接到房间');
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        return await sendWsRequest({
          type: 'push',
          url: input.url,
          source: input.source,
          ttlSec: input.ttlSec,
        });
      } catch {
        // Fallback to REST on WS failure/timeout
      }
    }
    return pushRest(input);
  }

  async function clear(): Promise<RelaySnapshot> {
    if (!currentRoom) throw new Error('未连接到房间');
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        return await sendWsRequest({ type: 'clear' });
      } catch {
        // Fallback to REST on WS failure/timeout
      }
    }
    return clearRest();
  }

  function sendReceipt(seq: number, kind: 'delivered' | 'jumped'): void {
    if (!currentRoom || !seq) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'receipt', seq, kind }));
        return;
      } catch {
        // fallback to REST keepalive
      }
    }
    if (typeof fetch === 'function') {
      fetch(`/api/v1/relay/${encodeURIComponent(currentRoom)}/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seq, cid, kind }),
        keepalive: true,
      }).catch(() => {});
    }
  }

  function onSnapshot(cb: (snap: RelaySnapshot, item: RelayItem | null) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  return {
    status: statusSig,
    transport: transportSig,
    rttMs: rttMsSig,
    errorText: errorTextSig,
    peers: peersSig,
    receipts: receiptsSig,
    activeItem: activeItemSig,
    seq: seqSig,
    clockOffsetMs: clockOffsetMsSig,
    connect,
    setRole,
    disconnect,
    reconnect,
    probeWakeup,
    push,
    clear,
    sendReceipt,
    onSnapshot,
  };
}
