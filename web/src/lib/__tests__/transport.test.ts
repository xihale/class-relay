import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelayTransport } from '../transport';
import type { RelaySnapshot } from '../../types/protocol';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }

  emitClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Array<(ev: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: Event) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  emitOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitEvent(type: string, payload: unknown): void {
    const ev = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const cb of this.listeners.get(type) ?? []) {
      cb(ev);
    }
  }

  emitError(closed = false): void {
    if (closed) this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}

describe('createRelayTransport', () => {
  const origWebSocket = globalThis.WebSocket;
  const origEventSource = globalThis.EventSource;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    MockEventSource.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () =>
          ({
            room: 'dorm402',
            seq: 1,
            active: false,
            serverTime: Date.now(),
          }) satisfies RelaySnapshot,
      })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.stubGlobal('WebSocket', origWebSocket);
    vi.stubGlobal('EventSource', origEventSource);
    vi.stubGlobal('fetch', origFetch);
  });

  it('connects over WS, receives snapshot, tracks ping/pong RTT, and sends receipts', () => {
    const transport = createRelayTransport();
    const snapshots: RelaySnapshot[] = [];
    transport.onSnapshot((s) => snapshots.push(s));

    transport.connect('dorm402', 'recv');
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain('/api/v1/relay/dorm402/ws');
    expect(ws.url).toContain('role=recv');

    ws.emitOpen();
    expect(transport.status.value).toBe('live');
    expect(transport.transport.value).toBe('ws');

    const now = Date.now();
    ws.emitMessage({
      type: 'state',
      room: 'dorm402',
      seq: 3,
      active: true,
      url: 'https://v18.teachermate.cn/sign/3',
      source: '微助教',
      host: 'v18.teachermate.cn',
      createdAt: now,
      expiresAt: now + 90_000,
      serverTime: now,
      peers: { total: 5, recv: 4, send: 1 },
      receipts: { delivered: 2, jumped: 1 },
    });

    expect(snapshots).toHaveLength(1);
    expect(transport.seq.value).toBe(3);
    expect(transport.activeItem.value?.url).toBe('https://v18.teachermate.cn/sign/3');
    expect(transport.peers.value).toEqual({ total: 5, recv: 4, send: 1 });
    expect(transport.receipts.value).toEqual({ delivered: 2, jumped: 1 });

    // 15s ping -> pong RTT tracking
    vi.advanceTimersByTime(15_000);
    expect(ws.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true);
    vi.advanceTimersByTime(25);
    ws.emitMessage({ type: 'pong', serverTime: Date.now() });
    expect(transport.rttMs.value).toBeGreaterThanOrEqual(20);

    // Send receipt over WS
    transport.sendReceipt(3, 'delivered');
    const lastFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(lastFrame).toEqual({ type: 'receipt', seq: 3, kind: 'delivered' });

    transport.disconnect();
  });

  it('probeWakeup reconnects immediately on 800ms pong timeout', () => {
    const transport = createRelayTransport();
    transport.connect('dorm402', 'recv');
    const ws1 = MockWebSocket.instances[0];
    ws1.emitOpen();

    transport.probeWakeup();
    expect(ws1.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true);

    // No pong within 800ms -> drops and schedules retry
    vi.advanceTimersByTime(800);
    expect(transport.status.value).toBe('reconnecting');

    vi.advanceTimersByTime(700);
    expect(MockWebSocket.instances).toHaveLength(2);
    transport.disconnect();
  });

  it('falls back WS -> SSE -> Long-Poll and sends keepalive REST receipt when WS is closed', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/receipt')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ ok: true }),
        });
      }
      if (url.includes('wait=15')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          room: 'dorm402',
          seq: 7,
          active: false,
          serverTime: Date.now(),
        }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = createRelayTransport();
    transport.connect('dorm402', 'recv');

    // WS failure #1 (connect timeout 2500ms)
    vi.advanceTimersByTime(2500);
    expect(transport.status.value).toBe('reconnecting');

    // Retry WS #2
    vi.advanceTimersByTime(650);
    expect(MockWebSocket.instances).toHaveLength(2);

    // WS failure #2 -> falls back to SSE
    MockWebSocket.instances[1].emitError();
    expect(transport.transport.value).toBe('sse');
    expect(MockEventSource.instances).toHaveLength(1);

    // SSE receives state event
    const es = MockEventSource.instances[0];
    es.emitOpen();
    expect(transport.status.value).toBe('live');
    es.emitEvent('state', {
      room: 'dorm402',
      seq: 5,
      active: false,
      serverTime: Date.now(),
    });
    expect(transport.seq.value).toBe(5);

    // SSE closed error -> falls back to Long-Poll
    es.emitError(true);
    expect(transport.transport.value).toBe('poll');

    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/relay/dorm402?since=5&wait=0'),
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(transport.seq.value).toBe(7);

    // Receipt falls back to keepalive REST fetch when WS is unavailable
    transport.sendReceipt(7, 'jumped');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/relay/dorm402/receipt',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
      }),
    );

    transport.disconnect();
  });
});
