// Classic IIFE Web Worker: self-hosted zxing-wasm@3.1.7 QR decoder + integer image enhancement kernel.
// Zero external CDN requests: locateFile overrides WASM path to same-origin /vendor/zxing_reader.wasm.

declare function importScripts(...urls: string[]): void;

interface ZXingReadOptions {
  formats: string[];
  tryHarder: boolean;
  tryRotate: boolean;
  tryInvert: boolean;
  tryDownscale: boolean;
  tryDenoise: boolean;
  binarizer: 'LocalAverage' | 'GlobalHistogram';
  maxNumberOfSymbols: number;
  textMode: 'Plain';
}

interface ZXingResult {
  isValid?: boolean;
  text?: string;
}

interface ZXingWASMGlobal {
  prepareZXingModule(opts: {
    overrides: { locateFile: (path: string) => string };
    fireImmediately: boolean;
  }): Promise<unknown>;
  readBarcodes(
    input: { data: Uint8ClampedArray; width: number; height: number },
    options: ZXingReadOptions,
  ): Promise<ZXingResult[]>;
}

declare const ZXingWASM: ZXingWASMGlobal;

if (typeof importScripts === 'function') {
  importScripts('/vendor/zxing-reader.js');
}

const WASM_URL = '/vendor/zxing_reader.wasm';

interface DecodeProfile {
  enhance: boolean;
  passes: ZXingReadOptions[];
}

const PROFILES: Record<string, DecodeProfile> = {
  'live-fast': {
    enhance: false,
    passes: [
      {
        formats: ['QRCode'],
        tryHarder: false,
        tryRotate: false,
        tryInvert: false,
        tryDownscale: false,
        tryDenoise: false,
        binarizer: 'LocalAverage',
        maxNumberOfSymbols: 1,
        textMode: 'Plain',
      },
    ],
  },
  'live-enhanced-local': {
    enhance: true,
    passes: [
      {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: false,
        tryInvert: true,
        tryDownscale: false,
        tryDenoise: true,
        binarizer: 'LocalAverage',
        maxNumberOfSymbols: 1,
        textMode: 'Plain',
      },
    ],
  },
  'live-enhanced-global': {
    enhance: true,
    passes: [
      {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: false,
        tryInvert: true,
        tryDownscale: false,
        tryDenoise: false,
        binarizer: 'GlobalHistogram',
        maxNumberOfSymbols: 1,
        textMode: 'Plain',
      },
    ],
  },
  'photo-fast': {
    enhance: false,
    passes: [
      {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: false,
        tryInvert: true,
        tryDownscale: true,
        tryDenoise: false,
        binarizer: 'LocalAverage',
        maxNumberOfSymbols: 1,
        textMode: 'Plain',
      },
    ],
  },
  'photo-enhanced': {
    enhance: true,
    passes: [
      {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: false,
        tryInvert: true,
        tryDownscale: true,
        tryDenoise: true,
        binarizer: 'LocalAverage',
        maxNumberOfSymbols: 1,
        textMode: 'Plain',
      },
      {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: false,
        tryInvert: true,
        tryDownscale: true,
        tryDenoise: false,
        binarizer: 'GlobalHistogram',
        maxNumberOfSymbols: 1,
        textMode: 'Plain',
      },
    ],
  },
};

let initPromise: Promise<unknown> | null = null;
let scratchGray: Uint8Array | null = null;
let scratchHist: Uint32Array | null = null;

function ensureZXing(): Promise<unknown> {
  if (!initPromise) {
    initPromise = ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile: (path: string) => (path.endsWith('.wasm') ? WASM_URL : path),
      },
      fireImmediately: true,
    }).catch((err: unknown) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

function resetScratch(): void {
  scratchGray = null;
  scratchHist = null;
}

// Fast in-place grayscale + 2%-98% percentile contrast stretch + integer fixed-point 3x3 unsharp mask.
function enhanceRgbaInPlace(rgba: Uint8ClampedArray, width: number, height: number): void {
  const n = width * height;
  if (n <= 0) return;

  if (!scratchGray || scratchGray.length < n) {
    scratchGray = new Uint8Array(n);
  }
  if (!scratchHist) {
    scratchHist = new Uint32Array(256);
  } else {
    scratchHist.fill(0);
  }

  const gray = scratchGray;
  const hist = scratchHist;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
    gray[i] = y;
    hist[y]++;
  }

  const loTarget = ((n * 2) / 100) | 0;
  const hiTarget = ((n * 98 + 99) / 100) | 0;
  let acc = 0;
  let lo = 0;
  let hi = 255;

  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= loTarget) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= hiTarget) {
      hi = v;
      break;
    }
  }

  const range = hi - lo;
  if (range >= 16) {
    const scaleFP = ((255 << 16) / range) | 0;
    for (let i = 0; i < n; i++) {
      const g = gray[i];
      if (g <= lo) {
        gray[i] = 0;
      } else if (g >= hi) {
        gray[i] = 255;
      } else {
        let v = ((g - lo) * scaleFP + 32768) >> 16;
        if (v > 255) v = 255;
        gray[i] = v;
      }
    }
  }

  for (let y = 0; y < height; y++) {
    const row = y * width;
    const innerY = y > 0 && y < height - 1;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      let out = gray[idx];
      if (innerY && x > 0 && x < width - 1) {
        const sum =
          gray[idx - width - 1] +
          gray[idx - width] +
          gray[idx - width + 1] +
          gray[idx - 1] +
          out +
          gray[idx + 1] +
          gray[idx + width - 1] +
          gray[idx + width] +
          gray[idx + width + 1];
        // Fixed-point divide by 9: 7282 / 65536 ≈ 1 / 9; unsharp gain 19 / 16 ≈ 1.1875
        const blur = (sum * 7282 + 32768) >> 16;
        out = out + (((out - blur) * 19) >> 4);
        if (out < 0) out = 0;
        else if (out > 255) out = 255;
      }
      const p = idx << 2;
      rgba[p] = out;
      rgba[p + 1] = out;
      rgba[p + 2] = out;
      rgba[p + 3] = 255;
    }
  }
}

function firstValidText(results: ZXingResult[] | unknown): string {
  if (!Array.isArray(results)) return '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i] as ZXingResult | undefined;
    if (r && r.isValid && r.text) return String(r.text).trim();
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i] as ZXingResult | undefined;
    if (r && r.text) return String(r.text).trim();
  }
  return '';
}

async function decodeRgba(
  width: number,
  height: number,
  buffer: ArrayBuffer,
  profileName: string,
): Promise<string> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength !== width * height * 4
  ) {
    throw new Error('Invalid RGBA frame dimensions or buffer length');
  }

  const profile = PROFILES[profileName] || PROFILES['live-fast'];
  await ensureZXing();

  const data = new Uint8ClampedArray(buffer);
  const input = { data, width, height };

  if (profile.enhance) {
    enhanceRgbaInPlace(data, width, height);
  }

  for (let i = 0; i < profile.passes.length; i++) {
    const text = firstValidText(await ZXingWASM.readBarcodes(input, profile.passes[i]));
    if (text) return text;
  }
  return '';
}

interface WorkerRequestMessage {
  id: number;
  type: 'init' | 'reset' | 'decode-rgba';
  width?: number;
  height?: number;
  buffer?: ArrayBuffer;
  profile?: string;
}

self.onmessage = async (event: MessageEvent<WorkerRequestMessage>) => {
  const msg = event.data || ({} as WorkerRequestMessage);
  const { id, type } = msg;
  const t0 = performance.now();

  try {
    if (type === 'init') {
      await ensureZXing();
      self.postMessage({
        id,
        ok: true,
        engine: 'zxing-wasm',
        elapsedMs: Math.round(performance.now() - t0),
      });
      return;
    }

    if (type === 'reset') {
      resetScratch();
      self.postMessage({
        id,
        ok: true,
        elapsedMs: Math.round(performance.now() - t0),
      });
      return;
    }

    if (type === 'decode-rgba') {
      const profile = msg.profile || 'live-fast';
      const text = await decodeRgba(
        msg.width ?? 0,
        msg.height ?? 0,
        msg.buffer as ArrayBuffer,
        profile,
      );
      self.postMessage({
        id,
        ok: true,
        text,
        engine: 'zxing-wasm',
        elapsedMs: Math.round(performance.now() - t0),
      });
      return;
    }

    self.postMessage({
      id,
      ok: false,
      text: '',
      error: `Unknown message type: ${String(type)}`,
      elapsedMs: Math.round(performance.now() - t0),
    });
  } catch (err: unknown) {
    self.postMessage({
      id,
      ok: false,
      text: '',
      error: (err instanceof Error ? err.message : String(err)) || 'Worker error',
      elapsedMs: Math.round(performance.now() - t0),
    });
  }
};
