// Classic Web Worker: self-hosted zxing-wasm@3.1.7 QR decoder + fast image enhancement kernel.
// Zero external CDN requests: locateFile overrides WASM path to same-origin /vendor/zxing_reader.wasm.

/* global importScripts, ZXingWASM, self */

'use strict';

importScripts('/vendor/zxing-reader.js');

const WASM_URL = '/vendor/zxing_reader.wasm';

const BASE_OPTIONS = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
  textMode: 'Plain',
};

const FAST_OPTIONS = {
  ...BASE_OPTIONS,
  tryDenoise: false,
  binarizer: 'LocalAverage',
};

const ENHANCED_LOCAL_OPTIONS = {
  ...BASE_OPTIONS,
  tryDenoise: true,
  binarizer: 'LocalAverage',
};

const ENHANCED_GLOBAL_OPTIONS = {
  ...BASE_OPTIONS,
  tryDenoise: false,
  binarizer: 'GlobalHistogram',
};

let initPromise = null;

function ensureZXing() {
  if (!initPromise) {
    initPromise = ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile: (path) => (path.endsWith('.wasm') ? WASM_URL : path),
      },
      fireImmediately: true,
    });
  }
  return initPromise;
}

// Fast in-place grayscale + 2%-98% percentile contrast stretch + 3x3 unsharp mask.
// Designed for washed-out / slightly out-of-focus classroom projector QR codes.
function enhanceRgbaInPlace(rgba, width, height) {
  const n = width * height;
  if (n <= 0) return;

  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
    gray[i] = y;
    hist[y]++;
  }

  const loTarget = Math.floor(n * 0.02);
  const hiTarget = Math.ceil(n * 0.98);
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

  if (hi - lo >= 16) {
    const scale = 255 / (hi - lo);
    for (let i = 0; i < n; i++) {
      let v = Math.round((gray[i] - lo) * scale);
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      gray[i] = v;
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
          gray[idx - width - 1] + gray[idx - width] + gray[idx - width + 1] +
          gray[idx - 1]         + out               + gray[idx + 1] +
          gray[idx + width - 1] + gray[idx + width] + gray[idx + width + 1];
        const blur = sum / 9;
        out = Math.round(out + 1.2 * (out - blur));
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

function firstValidText(results) {
  if (!Array.isArray(results)) return '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && r.isValid && r.text) return String(r.text).trim();
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && r.text) return String(r.text).trim();
  }
  return '';
}

async function decodeRgba(width, height, buffer, mode) {
  await ensureZXing();
  if (!buffer || buffer.byteLength < width * height * 4) return '';
  const data = new Uint8ClampedArray(buffer);
  const input = { data, width, height };

  if (mode === 'enhanced') {
    enhanceRgbaInPlace(data, width, height);
    let text = firstValidText(await ZXingWASM.readBarcodes(input, ENHANCED_LOCAL_OPTIONS));
    if (!text) {
      text = firstValidText(await ZXingWASM.readBarcodes(input, ENHANCED_GLOBAL_OPTIONS));
    }
    return text;
  }

  return firstValidText(await ZXingWASM.readBarcodes(input, FAST_OPTIONS));
}

async function decodeBlob(blob) {
  await ensureZXing();
  let text = firstValidText(await ZXingWASM.readBarcodes(blob, FAST_OPTIONS));
  if (!text) {
    text = firstValidText(await ZXingWASM.readBarcodes(blob, ENHANCED_LOCAL_OPTIONS));
  }
  if (!text) {
    text = firstValidText(await ZXingWASM.readBarcodes(blob, ENHANCED_GLOBAL_OPTIONS));
  }
  return text;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
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

    if (type === 'decode-rgba') {
      const text = await decodeRgba(msg.width, msg.height, msg.buffer, msg.mode || 'fast');
      self.postMessage({
        id,
        text,
        engine: 'zxing-wasm',
        elapsedMs: Math.round(performance.now() - t0),
      });
      return;
    }

    if (type === 'decode-blob') {
      const text = await decodeBlob(msg.blob);
      self.postMessage({
        id,
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
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      text: '',
      error: (err && err.message) || String(err),
      elapsedMs: Math.round(performance.now() - t0),
    });
  }
};
