// Web 扫码器：实时后置摄像头扫描 + 拍照/相册静态图识别。
// 优先使用浏览器原生 BarcodeDetector，不支持时按需加载同源 /vendor/jsqr.js。

import { h, icon, openDialog } from './dom.js';

const URL_RE = /https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCT_RE = /[.,;!?)\]}'"，。；！？）】》]+$/;

let barcodeDetectorPromise = null;
let jsQRPromise = null;

export function extractUrl(text) {
  const m = URL_RE.exec(String(text || '').trim());
  if (!m) return '';
  return m[0].replace(TRAILING_PUNCT_RE, '');
}

async function getBarcodeDetector() {
  if (barcodeDetectorPromise) return barcodeDetectorPromise;
  barcodeDetectorPromise = (async () => {
    if (typeof globalThis.BarcodeDetector !== 'function') return null;
    try {
      if (typeof globalThis.BarcodeDetector.getSupportedFormats === 'function') {
        const formats = await globalThis.BarcodeDetector.getSupportedFormats();
        if (!formats.includes('qr_code')) return null;
      }
      return new globalThis.BarcodeDetector({ formats: ['qr_code'] });
    } catch {
      return null;
    }
  })();
  return barcodeDetectorPromise;
}

function ensureJsQR() {
  if (typeof globalThis.jsQR === 'function') return Promise.resolve(globalThis.jsQR);
  if (jsQRPromise) return jsQRPromise;
  jsQRPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsqr.js';
    s.async = true;
    s.onload = () => {
      if (typeof globalThis.jsQR === 'function') resolve(globalThis.jsQR);
      else {
        jsQRPromise = null;
        reject(new Error('二维码解码库初始化失败'));
      }
    };
    s.onerror = () => {
      s.remove();
      jsQRPromise = null;
      reject(new Error('无法加载本地二维码解码库'));
    };
    document.head.append(s);
  });
  return jsQRPromise;
}

async function decodeCanvas(canvas, ctx, { thorough = false } = {}) {
  const detector = await getBarcodeDetector();
  if (detector) {
    try {
      const codes = await detector.detect(canvas);
      if (codes && codes.length > 0 && codes[0].rawValue) {
        return codes[0].rawValue.trim();
      }
    } catch { /* fallback to jsQR */ }
  }

  const jsQR = await ensureJsQR();
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const res = jsQR(imgData.data, imgData.width, imgData.height, {
    inversionAttempts: thorough ? 'attemptBoth' : 'dontInvert',
  });
  return res && res.data ? res.data.trim() : '';
}

function loadImageElement(blobUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = blobUrl;
  });
}

export async function decodeImageFile(file) {
  if (!file) throw new Error('未选择图片');
  const maxDim = 1600;
  let source = null;
  let revokeUrl = '';
  let bitmap = null;

  try {
    if (typeof createImageBitmap === 'function') {
      try {
        bitmap = await createImageBitmap(file);
        source = bitmap;
      } catch { /* fallback to Image */ }
    }
    if (!source) {
      revokeUrl = URL.createObjectURL(file);
      source = await loadImageElement(revokeUrl);
    }

    const srcW = source.naturalWidth || source.width;
    const srcH = source.naturalHeight || source.height;
    if (!srcW || !srcH) throw new Error('图片尺寸无效');

    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const hPx = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hPx;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, hPx);

    const text = await decodeCanvas(canvas, ctx, { thorough: true });
    if (!text) throw new Error('未在图片中识别到二维码，请对准清晰二维码重试');
    return text;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (revokeUrl) URL.revokeObjectURL(revokeUrl);
  }
}

export function openCameraScanner({ onResult, onPickFile }) {
  let stream = null;
  let closed = false;
  let rafId = 0;
  let lastScanAt = 0;
  let scanning = false;

  const video = h('video', {
    class: 'scanner-video',
    playsinline: true,
    muted: true,
    autoplay: true,
  });
  const statusEl = h('p', { class: 'scanner-status' }, '正在请求后置摄像头权限…');

  const stopCamera = () => {
    closed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    video.srcObject = null;
  };

  const content = h('div', { class: 'scanner-sheet' },
    h('div', { class: 'sheet-head' },
      h('h2', {}, '网页相机扫码'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '关闭', onclick: () => dlg.close() }, icon('x'))),
    h('div', { class: 'scanner-stage' },
      video,
      h('div', { class: 'scanner-frame', 'aria-hidden': 'true' })),
    h('div', { class: 'scanner-foot' },
      statusEl,
      h('div', { class: 'scanner-actions' },
        h('button', {
          type: 'button',
          class: 'btn tonal',
          onclick: () => {
            dlg.close();
            if (typeof onPickFile === 'function') onPickFile();
          },
        }, icon('image', 18), '拍照 / 相册识码'),
        h('button', {
          type: 'button',
          class: 'btn ghost',
          onclick: () => dlg.close(),
        }, '关闭'))));

  const dlg = openDialog(content, { label: '网页相机扫码', onClose: stopCamera });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const loop = async (now) => {
    if (closed) return;
    rafId = requestAnimationFrame(loop);
    if (scanning || now - lastScanAt < 140) return;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

    scanning = true;
    lastScanAt = now;
    try {
      const maxDim = 960;
      const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(1, Math.round(video.videoWidth * scale));
      const hPx = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== w || canvas.height !== hPx) {
        canvas.width = w;
        canvas.height = hPx;
      }
      ctx.drawImage(video, 0, 0, w, hPx);
      const text = await decodeCanvas(canvas, ctx, { thorough: false });
      if (text && !closed) {
        dlg.close();
        if (typeof onResult === 'function') onResult(text);
        return;
      }
    } catch { /* continue scanning */ } finally {
      scanning = false;
    }
  };

  (async () => {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      statusEl.textContent = '当前环境不支持网页摄像头（需 HTTPS），请改用下方「拍照 / 相册识码」。';
      return;
    }
    try {
      const detector = await getBarcodeDetector();
      if (!detector) {
        statusEl.textContent = '正在加载本地二维码解码器…';
        await ensureJsQR();
      }
      if (closed) return;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (closed) {
        stopCamera();
        return;
      }
      video.srcObject = stream;
      await video.play();
      statusEl.textContent = '请将教室大屏上的签到二维码对准取景框';
      rafId = requestAnimationFrame(loop);
    } catch (err) {
      if (closed) return;
      const msg = err && err.name === 'NotAllowedError'
        ? '未授予摄像头权限，请在浏览器设置中允许或使用「拍照 / 相册识码」。'
        : `无法打开摄像头（${(err && err.message) || '权限受限'}），可改用「拍照 / 相册识码」。`;
      statusEl.textContent = msg;
    }
  })();

  return dlg;
}
