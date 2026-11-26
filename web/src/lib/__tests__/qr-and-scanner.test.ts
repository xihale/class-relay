import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearQRCache, makeQRMatrix, renderQRDataURL } from '../qr';
import { extractUrl } from '../scanner';

describe('qr.ts', () => {
  afterEach(() => {
    clearQRCache();
    vi.restoreAllMocks();
  });

  it('generates valid QR matrix with finder patterns and expected dimensions', () => {
    const m = makeQRMatrix('https://v18.teachermate.cn/sign/abc');
    expect(m.size).toBeGreaterThanOrEqual(21);
    expect((m.size - 17) % 4).toBe(0);
    expect(m.data.length).toBe(m.size * m.size);
    // Top-left 7x7 finder outer border is dark (1)
    expect(m.data[0]).toBe(1);
    expect(m.data[6]).toBe(1);
    expect(m.data[6 * m.size]).toBe(1);
    // Inner 3x3 center of top-left finder is dark (1)
    expect(m.data[3 * m.size + 3]).toBe(1);
  });

  it('caches renderQRDataURL with 8-entry LRU eviction', () => {
    const fillRect = vi.fn();
    const beginPath = vi.fn();
    const rect = vi.fn();
    const fill = vi.fn();
    let callCount = 0;

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'canvas') {
        callCount++;
        return {
          width: 0,
          height: 0,
          getContext: () => ({ fillStyle: '', fillRect, beginPath, rect, fill }),
          toDataURL: () => `data:image/png;base64,mock-${callCount}`,
        } as unknown as HTMLCanvasElement;
      }
      return origCreate(tag);
    }) as typeof document.createElement);

    const first = renderQRDataURL('https://example.com/1', 260);
    const second = renderQRDataURL('https://example.com/1', 260);
    expect(first).toBe(second);
    expect(callCount).toBe(1);

    // Fill 8 more distinct keys to evict the oldest entry
    for (let i = 2; i <= 9; i++) {
      renderQRDataURL(`https://example.com/${i}`, 260);
    }
    expect(callCount).toBe(9);

    // Key 1 was evicted, so rendering it again creates a new canvas
    const reRendered = renderQRDataURL('https://example.com/1', 260);
    expect(reRendered).not.toBe(first);
    expect(callCount).toBe(10);
  });
});

describe('scanner extractUrl', () => {
  it('extracts http/https URLs and strips trailing punctuation', () => {
    expect(extractUrl('请打开 https://v18.teachermate.cn/sign?id=123。')).toBe(
      'https://v18.teachermate.cn/sign?id=123',
    );
    expect(extractUrl('(https://example.com/a/b?c=1),')).toBe('https://example.com/a/b?c=1');
    expect(extractUrl('纯文本没有链接')).toBe('');
    expect(extractUrl('')).toBe('');
  });
});
