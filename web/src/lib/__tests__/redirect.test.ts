import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRedirectController } from '../redirect';
import type { RelayItem } from '../../types/protocol';

function makeItem(seq = 1, url = 'https://v18.teachermate.cn/sign/1'): RelayItem {
  const now = Date.now();
  return {
    seq,
    room: 'dorm402',
    url,
    source: '微助教',
    host: 'v18.teachermate.cn',
    createdAt: now,
    expiresAt: now + 90_000,
    expiresAtLocal: now + 90_000,
  };
}

describe('createRedirectController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('gates unfocused page into awaiting-focus, then auto-jumps on focus regain', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const nav = vi.fn();
    const jumped = vi.fn();
    const ctrl = createRedirectController({ onJumped: jumped, navigate: nav });

    const item = makeItem(10);
    ctrl.handleIncoming('dorm402', item, { mode: 'recv', autoRedirect: true });

    expect(ctrl.status.value).toBe('awaiting-focus');
    expect(ctrl.isTapJumpArmed.value).toBe(true);
    expect(nav).not.toHaveBeenCalled();
    expect(ctrl.hasRedirected(item)).toBe(false);

    // Focus regain triggers immediate synchronous navigation
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));

    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledWith(item.url);
    expect(ctrl.status.value).toBe('navigating');
    expect(jumped).not.toHaveBeenCalled();

    // Confirmed on pagehide -> dedup stored + onJumped fired once
    window.dispatchEvent(new Event('pagehide'));
    expect(ctrl.status.value).toBe('done');
    expect(ctrl.alreadyRedirected.value).toBe(true);
    expect(ctrl.hasRedirected(item)).toBe(true);
    expect(jumped).toHaveBeenCalledTimes(1);
    expect(jumped).toHaveBeenCalledWith(10);

    ctrl.dispose();
  });

  it('transitions to blocked after 1200ms stall watchdog and confirms on gesture', () => {
    const nav = vi.fn();
    const jumped = vi.fn();
    const ctrl = createRedirectController({ onJumped: jumped, navigate: nav });

    const item = makeItem(20);
    ctrl.handleIncoming('dorm402', item, { mode: 'recv', autoRedirect: true });
    expect(ctrl.status.value).toBe('navigating');
    expect(nav).toHaveBeenCalledTimes(1);

    // Still visible after 1200ms -> WeChat blocked navigation
    vi.advanceTimersByTime(1200);
    expect(ctrl.status.value).toBe('blocked');
    expect(ctrl.isTapJumpArmed.value).toBe(true);
    expect(ctrl.hasRedirected(item)).toBe(false);
    expect(jumped).not.toHaveBeenCalled();

    // User taps to jump (fromGesture: true)
    const ok = ctrl.tryExecute({ fromGesture: true });
    expect(ok).toBe(true);
    expect(nav).toHaveBeenCalledTimes(2);
    expect(ctrl.hasRedirected(item)).toBe(true);
    expect(jumped).toHaveBeenCalledTimes(1);
    expect(jumped).toHaveBeenCalledWith(20);

    // Subsequent pagehide does NOT double-fire onJumped
    window.dispatchEvent(new Event('pagehide'));
    expect(jumped).toHaveBeenCalledTimes(1);

    ctrl.dispose();
  });

  it('recovers from bfcache pageshow without looping redirects', () => {
    const nav = vi.fn();
    const jumped = vi.fn();
    const ctrl = createRedirectController({ onJumped: jumped, navigate: nav });

    const item = makeItem(30);
    ctrl.handleIncoming('dorm402', item, { mode: 'recv', autoRedirect: true });
    expect(nav).toHaveBeenCalledTimes(1);

    // Page leaves via pagehide
    window.dispatchEvent(new Event('pagehide'));
    expect(ctrl.hasRedirected(item)).toBe(true);

    // Returns via bfcache (pageshow with persisted: true)
    const ev = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(ev, 'persisted', { value: true });
    window.dispatchEvent(ev);

    expect(ctrl.status.value).toBe('done');
    expect(ctrl.pending.value).toBeNull();
    expect(ctrl.alreadyRedirected.value).toBe(true);

    // Receiving the same item again does NOT re-trigger navigation
    ctrl.handleIncoming('dorm402', item, { mode: 'recv', autoRedirect: true });
    expect(nav).toHaveBeenCalledTimes(1);

    ctrl.dispose();
  });
});
