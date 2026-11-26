import { computed, signal, type ReadonlySignal } from '@preact/signals';
import type { RedirectStatus, RelayItem, Role } from '../types/protocol';

const SESSION_REDIRECTED = 'class-relay-redirected';
const MAX_REDIRECTED_KEYS = 12;
const REDIRECT_WATCHDOG_MS = 1200;

function hasDocumentFocus(): boolean {
  if (typeof document === 'undefined') return true;
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible';
}

function loadRedirectedKeys(): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSION_REDIRECTED);
    if (!raw) return [];
    if (raw.startsWith('[')) {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((k): k is string => typeof k === 'string') : [];
    }
    return [raw];
  } catch {
    return [];
  }
}

function hasRedirectedKey(key: string): boolean {
  if (!key) return false;
  return loadRedirectedKeys().includes(key);
}

function markRedirectedKey(key: string): void {
  if (!key) return;
  try {
    const next = loadRedirectedKeys().filter((k) => k !== key);
    next.push(key);
    if (next.length > MAX_REDIRECTED_KEYS) {
      next.splice(0, next.length - MAX_REDIRECTED_KEYS);
    }
    globalThis.sessionStorage?.setItem(SESSION_REDIRECTED, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
}

export interface RedirectControllerOptions {
  onJumped?: (seq: number) => void;
  navigate?: (url: string) => void;
}

export interface RedirectController {
  readonly isWeChat: boolean;
  readonly visible: ReadonlySignal<boolean>;
  readonly focused: ReadonlySignal<boolean>;
  readonly status: ReadonlySignal<RedirectStatus>;
  readonly pending: ReadonlySignal<RelayItem | null>;
  readonly alreadyRedirected: ReadonlySignal<boolean>;
  readonly isTapJumpArmed: ReadonlySignal<boolean>;
  handleIncoming(room: string, item: RelayItem | null, opts: { mode: Role; autoRedirect: boolean }): void;
  tryExecute(opts?: { fromGesture?: boolean }): boolean;
  confirmManualJump(item: RelayItem): void;
  hasRedirected(item: RelayItem): boolean;
  reset(): void;
  dispose(): void;
}

export function createRedirectController(opts?: RedirectControllerOptions): RedirectController {
  const onJumped = opts?.onJumped;
  const navigate =
    opts?.navigate ??
    ((url: string) => {
      window.location.assign(url);
    });

  const isWeChat =
    typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent || '');

  const visibleSig = signal<boolean>(isDocumentVisible());
  const focusedSig = signal<boolean>(hasDocumentFocus());
  const statusSig = signal<RedirectStatus>('idle');
  const pendingSig = signal<RelayItem | null>(null);
  const alreadyRedirectedSig = signal<boolean>(false);
  const modeSig = signal<Role>('recv');

  const isTapJumpArmed = computed<boolean>(
    () =>
      modeSig.value === 'recv' &&
      pendingSig.value !== null &&
      (statusSig.value === 'awaiting-focus' || statusSig.value === 'blocked'),
  );

  let currentRoom = '';
  let lastItem: RelayItem | null = null;
  let inFlightKey: string | null = null;
  let inFlightSeq = 0;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const notifiedKeys = new Set<string>();
  let disposed = false;

  function itemKey(item: RelayItem, roomOverride?: string): string {
    const r = roomOverride || item.room || currentRoom;
    return `${r}:${item.seq}:${item.url}`;
  }

  function clearWatchdog(): void {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function notifyJumpedOnce(key: string, seq: number): void {
    if (!key || notifiedKeys.has(key)) return;
    notifiedKeys.add(key);
    if (onJumped) {
      try {
        onJumped(seq);
      } catch {
        // ignore callback errors
      }
    }
  }

  function clearPending(): void {
    clearWatchdog();
    pendingSig.value = null;
    inFlightKey = null;
    inFlightSeq = 0;
    statusSig.value = 'idle';
  }

  function confirmInFlight(): void {
    if (!inFlightKey) return;
    const key = inFlightKey;
    const seq = inFlightSeq;
    inFlightKey = null;
    inFlightSeq = 0;
    clearWatchdog();
    markRedirectedKey(key);
    alreadyRedirectedSig.value = true;
    statusSig.value = 'done';
    notifyJumpedOnce(key, seq);
  }

  function tryExecute(execOpts?: { fromGesture?: boolean }): boolean {
    if (disposed) return false;
    const fromGesture = Boolean(execOpts?.fromGesture);
    const pending = pendingSig.value;
    if (!pending) return false;

    const key = itemKey(pending);
    const alreadyDone = hasRedirectedKey(key);
    const valid = modeSig.value === 'recv' && pending.expiresAtLocal > Date.now() && !alreadyDone;

    if (!valid) {
      if (alreadyDone) {
        clearWatchdog();
        pendingSig.value = null;
        inFlightKey = null;
        inFlightSeq = 0;
        statusSig.value = 'done';
        alreadyRedirectedSig.value = true;
      } else {
        clearPending();
      }
      return false;
    }

    // Re-entrancy guard: already navigating and not an explicit gesture.
    if (statusSig.value === 'navigating' && !fromGesture) {
      return false;
    }

    // Focus gate: when not triggered by user gesture and page is hidden or unfocused,
    // do not mark redirected; instead enter awaiting-focus for immediate tap/focus jump.
    if (!fromGesture) {
      const canAuto = visibleSig.value && focusedSig.value;
      if (!canAuto) {
        statusSig.value = 'awaiting-focus';
        return false;
      }
    }

    clearWatchdog();
    inFlightKey = key;
    inFlightSeq = pending.seq;
    statusSig.value = 'navigating';

    if (fromGesture) {
      markRedirectedKey(key);
      alreadyRedirectedSig.value = true;
      notifyJumpedOnce(key, pending.seq);
    }

    // Synchronous location.assign (preserves back-button history, zero 120ms timer delay).
    navigate(pending.url);

    // 1200ms stall watchdog: if still visible & in-flight, browser/WeChat blocked the navigation.
    const expectedKey = key;
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (visibleSig.value && inFlightKey === expectedKey) {
        inFlightKey = null;
        inFlightSeq = 0;
        statusSig.value = 'blocked';
      }
    }, REDIRECT_WATCHDOG_MS);

    return true;
  }

  function handleIncoming(
    room: string,
    item: RelayItem | null,
    incomingOpts: { mode: Role; autoRedirect: boolean },
  ): void {
    if (disposed) return;
    currentRoom = room;
    modeSig.value = incomingOpts.mode;
    lastItem = item;

    if (!item) {
      clearPending();
      alreadyRedirectedSig.value = false;
      return;
    }

    const key = itemKey(item, room);
    const alreadyDone = hasRedirectedKey(key);
    alreadyRedirectedSig.value = alreadyDone;

    if (incomingOpts.mode === 'recv') {
      if (incomingOpts.autoRedirect && !alreadyDone) {
        const curPending = pendingSig.value;
        const samePending = curPending !== null && itemKey(curPending) === key;
        if (!samePending) {
          clearWatchdog();
          inFlightKey = null;
          inFlightSeq = 0;
          pendingSig.value = item;
          statusSig.value = 'idle';
        }
        tryExecute({ fromGesture: false });
      } else {
        const curPending = pendingSig.value;
        if (curPending && itemKey(curPending) !== key) {
          clearPending();
        }
        if (alreadyDone) {
          pendingSig.value = null;
        }
        statusSig.value = alreadyDone ? 'done' : 'idle';
      }
    } else {
      clearPending();
    }
  }

  function confirmManualJump(item: RelayItem): void {
    if (!item) return;
    const key = itemKey(item);
    clearWatchdog();
    inFlightKey = null;
    inFlightSeq = 0;
    pendingSig.value = null;
    markRedirectedKey(key);
    alreadyRedirectedSig.value = true;
    statusSig.value = 'done';
    notifyJumpedOnce(key, item.seq);
  }

  function hasRedirected(item: RelayItem): boolean {
    if (!item) return false;
    return hasRedirectedKey(itemKey(item));
  }

  function reset(): void {
    clearPending();
    lastItem = null;
    alreadyRedirectedSig.value = false;
  }

  const onFocus = () => {
    focusedSig.value = true;
    if (pendingSig.value && statusSig.value === 'awaiting-focus') {
      tryExecute({ fromGesture: false });
    }
  };

  const onBlur = () => {
    focusedSig.value = false;
    if (pendingSig.value && statusSig.value === 'idle') {
      statusSig.value = 'awaiting-focus';
    }
  };

  const onVisibilityChange = () => {
    const vis = isDocumentVisible();
    visibleSig.value = vis;
    if (!vis) {
      confirmInFlight();
      return;
    }
    focusedSig.value = hasDocumentFocus();
    if (pendingSig.value && (statusSig.value === 'awaiting-focus' || statusSig.value === 'idle')) {
      tryExecute({ fromGesture: false });
    }
  };

  const onPageHide = () => {
    confirmInFlight();
  };

  const onPageShow = (e: PageTransitionEvent) => {
    clearWatchdog();
    inFlightKey = null;
    inFlightSeq = 0;
    visibleSig.value = isDocumentVisible();
    focusedSig.value = hasDocumentFocus();

    if (!e.persisted) return;

    const curPending = pendingSig.value;
    if (curPending && hasRedirectedKey(itemKey(curPending))) {
      pendingSig.value = null;
      statusSig.value = 'done';
      alreadyRedirectedSig.value = true;
    } else if (lastItem && hasRedirectedKey(itemKey(lastItem))) {
      pendingSig.value = null;
      statusSig.value = 'done';
      alreadyRedirectedSig.value = true;
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearWatchdog();
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  }

  return {
    isWeChat,
    visible: visibleSig,
    focused: focusedSig,
    status: statusSig,
    pending: pendingSig,
    alreadyRedirected: alreadyRedirectedSig,
    isTapJumpArmed,
    handleIncoming,
    tryExecute,
    confirmManualJump,
    hasRedirected,
    reset,
    dispose,
  };
}
