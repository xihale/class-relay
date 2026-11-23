// Web 扫码器：自托管 zxing-wasm@3.1.7 Classic Worker + 硬件/1:1 传感器像素混合变焦
// + 4 帧多尺度/图像增强轮转 + 5 阶段高清图片解码 + jsQR 零 WASM 降级兜底。

import { h, icon, openDialog } from './dom.js';

const URL_RE = /https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCT_RE = /[.,;!?)\]}'"，。；！？）】》]+$/;

const DIGITAL_STEPS = [1, 1.5, 2, 3, 5];
const ZOOM_PRESETS = [1, 2, 3, 5];
const ZOOM_CLASS_LIST = ['zoom-1', 'zoom-1-5', 'zoom-2', 'zoom-3', 'zoom-5'];

// 3x3 重叠网格优先顺序（教室投影高频区域优先：上中、中中、左上、右上…）
const TILE_ORDER = [
  [1, 0], [1, 1], [0, 0], [2, 0],
  [0, 1], [2, 1], [1, 2], [0, 2], [2, 2],
];

let barcodeDetectorPromise = null;
let jsQRPromise = null;
let workerInstance = null;
let workerInitPromise = null;
let workerFailed = false;
let workerNextId = 1;
const workerPending = new Map();

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

function failAllWorkerPending(err) {
  workerFailed = true;
  for (const [, entry] of workerPending) {
    entry.reject(err);
  }
  workerPending.clear();
  if (workerInstance) {
    try { workerInstance.terminate(); } catch { /* ignore */ }
    workerInstance = null;
  }
  workerInitPromise = null;
}

function terminateWorker() {
  const err = new Error('Worker 已终止');
  for (const [, entry] of workerPending) {
    entry.reject(err);
  }
  workerPending.clear();
  if (workerInstance) {
    try { workerInstance.terminate(); } catch { /* ignore */ }
    workerInstance = null;
  }
  workerInitPromise = null;
}

function sendWorkerRequest(payload, transfer = []) {
  return new Promise((resolve, reject) => {
    if (!workerInstance || workerFailed) {
      reject(new Error('Worker 不可用'));
      return;
    }
    const id = workerNextId++;
    workerPending.set(id, { resolve, reject });
    try {
      workerInstance.postMessage({ ...payload, id }, transfer);
    } catch (err) {
      workerPending.delete(id);
      reject(err);
    }
  });
}

async function ensureWorker() {
  if (workerFailed) return false;
  if (workerInitPromise) return workerInitPromise;
  if (typeof globalThis.Worker !== 'function' || typeof globalThis.WebAssembly !== 'object') {
    workerFailed = true;
    return false;
  }

  workerInitPromise = (async () => {
    let w = null;
    try {
      w = new Worker('/scanner-worker.js');
      workerInstance = w;
      w.onmessage = (event) => {
        const msg = event.data || {};
        const entry = workerPending.get(msg.id);
        if (!entry) return;
        workerPending.delete(msg.id);
        entry.resolve(msg);
      };
      w.onerror = (err) => {
        if (workerInstance === w) {
          failAllWorkerPending(new Error((err && err.message) || 'Worker 运行异常'));
        }
      };
      const res = await sendWorkerRequest({ type: 'init' });
      if (!res || !res.ok) {
        if (workerInstance === w) {
          failAllWorkerPending(new Error((res && res.error) || 'WASM 初始化失败'));
        }
        return false;
      }
      return workerInstance === w;
    } catch (err) {
      if (!w || workerInstance === w) {
        failAllWorkerPending(err);
      }
      return false;
    }
  })();

  return workerInitPromise;
}

async function decodeWithJsQR(ctx, width, height) {
  const jsQR = await ensureJsQR();
  const imgData = ctx.getImageData(0, 0, width, height);
  const res = jsQR(imgData.data, imgData.width, imgData.height, {
    inversionAttempts: 'attemptBoth',
  });
  return res && res.data ? res.data.trim() : '';
}

async function decodeCanvas(canvas, ctx, { mode = 'fast', useBarcodeDetector = true } = {}) {
  if (useBarcodeDetector && mode !== 'enhanced') {
    const detector = await getBarcodeDetector();
    if (detector) {
      try {
        const codes = await detector.detect(canvas);
        if (codes && codes.length > 0 && codes[0].rawValue) {
          return codes[0].rawValue.trim();
        }
      } catch { /* fall through to WASM */ }
    }
  }

  const workerOk = await ensureWorker();
  if (workerOk) {
    try {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const buf = imgData.data.buffer;
      const res = await sendWorkerRequest(
        { type: 'decode-rgba', width: canvas.width, height: canvas.height, buffer: buf, mode },
        [buf],
      );
      if (res && res.text) return res.text;
      if (!res || res.error) {
        // 仅在出错时尝试 jsQR 兜底，正常未检出不重复跑 jsQR
        if (res && res.error) return decodeWithJsQR(ctx, canvas.width, canvas.height);
      }
      return '';
    } catch { /* fallback to jsQR */ }
  }

  return decodeWithJsQR(ctx, canvas.width, canvas.height);
}

function drawRegion(canvas, ctx, source, sx, sy, sw, sh, maxDim, minDim = 0) {
  const safeW = Math.max(1, Math.round(sw));
  const safeH = Math.max(1, Math.round(sh));
  const longSide = Math.max(safeW, safeH);

  let scale = 1;
  if (maxDim > 0 && longSide > maxDim) {
    scale = maxDim / longSide;
  } else if (minDim > 0 && longSide < minDim) {
    scale = minDim / longSide;
  }

  const dw = Math.max(1, Math.round(safeW * scale));
  const dh = Math.max(1, Math.round(safeH * scale));
  if (canvas.width !== dw || canvas.height !== dh) {
    canvas.width = dw;
    canvas.height = dh;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, safeW, safeH, 0, 0, dw, dh);
}

function loadImageElement(blobUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = blobUrl;
  });
}

async function decodeSourceFiveStage(source, srcW, srcH, { onProgress } = {}) {
  const report = (label) => {
    if (typeof onProgress === 'function') {
      try { onProgress(label); } catch { /* ignore */ }
    }
  };

  // 阶段 1：原生 BarcodeDetector 满分辨率快速预检
  report('正在快速预检原图…');
  const detector = await getBarcodeDetector();
  if (detector) {
    try {
      const codes = await detector.detect(source);
      if (codes && codes.length > 0 && codes[0].rawValue) {
        return codes[0].rawValue.trim();
      }
    } catch { /* continue */ }
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // 阶段 2：全图 1800px 标准通道
  report('正在解析高清原图…');
  drawRegion(canvas, ctx, source, 0, 0, srcW, srcH, 1800);
  let text = await decodeCanvas(canvas, ctx, { mode: 'fast', useBarcodeDetector: false });
  if (text) return text;

  // 阶段 3：1:1 原分辨率中心 60% 与 35% 裁剪
  report('正在精扫中心区域…');
  for (const [ratio, minDim] of [[0.60, 0], [0.35, 480]]) {
    const cw = srcW * ratio;
    const ch = srcH * ratio;
    const cx = (srcW - cw) / 2;
    const cy = (srcH - ch) / 2;
    drawRegion(canvas, ctx, source, cx, cy, cw, ch, 1400, minDim);
    text = await decodeCanvas(canvas, ctx, { mode: 'fast', useBarcodeDetector: false });
    if (text) return text;
  }

  // 阶段 4：原分辨率 3x3 重叠网格切块（45% 宽×高，步进 27.5%，上限 1000px）
  report('正在分区扫描…');
  const tileW = srcW * 0.45;
  const tileH = srcH * 0.45;
  const stepX = srcW * 0.275;
  const stepY = srcH * 0.275;
  for (const [col, row] of TILE_ORDER) {
    const sx = Math.min(srcW - tileW, Math.max(0, col * stepX));
    const sy = Math.min(srcH - tileH, Math.max(0, row * stepY));
    drawRegion(canvas, ctx, source, sx, sy, tileW, tileH, 1000);
    text = await decodeCanvas(canvas, ctx, { mode: 'fast', useBarcodeDetector: false });
    if (text) return text;
  }

  // 阶段 5：图像增强通道（2%-98% 对比度拉伸 + 3x3 锐化 + tryDenoise + GlobalHistogram）
  report('正在增强对比度识别…');
  for (const [ratio, minDim] of [[0.55, 0], [0.35, 480]]) {
    const cw = srcW * ratio;
    const ch = srcH * ratio;
    const cx = (srcW - cw) / 2;
    const cy = (srcH - ch) / 2;
    drawRegion(canvas, ctx, source, cx, cy, cw, ch, 960, minDim);
    text = await decodeCanvas(canvas, ctx, { mode: 'enhanced', useBarcodeDetector: false });
    if (text) return text;
  }

  return '';
}

export async function decodeImageFile(file, { onProgress } = {}) {
  if (!file) throw new Error('未选择图片');
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

    const text = await decodeSourceFiveStage(source, srcW, srcH, { onProgress });
    if (!text) throw new Error('未在图片中识别到二维码，请对准清晰二维码重试');
    return text;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (revokeUrl) URL.revokeObjectURL(revokeUrl);
  }
}

function snapDigitalZoom(raw) {
  let best = DIGITAL_STEPS[0];
  let bestDiff = Math.abs(raw - best);
  for (let i = 1; i < DIGITAL_STEPS.length; i++) {
    const diff = Math.abs(raw - DIGITAL_STEPS[i]);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = DIGITAL_STEPS[i];
    }
  }
  return best;
}

function digitalZoomClass(factor) {
  return `zoom-${String(factor).replace('.', '-')}`;
}

function formatZoomLabel(z) {
  const rounded = Math.round(z * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}x`;
}

function touchDistance(t1, t2) {
  return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
}

export function openCameraScanner({ onResult, onPickFile }) {
  let stream = null;
  let videoTrack = null;
  let trackCaps = {};
  let imageCapture = null;
  let closed = false;
  let rafId = 0;
  let lastScanAt = 0;
  let workerBusy = false;
  let shutterBusy = false;
  let frameIndex = 0;

  let hasHwZoom = false;
  let hwZoomMin = 1;
  let hwZoomMax = 1;
  let targetZoom = 1;
  let currentHwZoom = 1;
  let currentDigitalZoom = 1;
  let lastAppliedHwZoom = 1;
  let zoomThrottleTimer = 0;
  let lastHwZoomAt = 0;
  let torchOn = false;
  let focusTimer = 0;
  let engineLabel = 'WASM 高清';

  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let isPinching = false;

  const video = h('video', {
    class: 'scanner-video zoom-1',
    playsinline: true,
    muted: true,
    autoplay: true,
  });
  const frameEl = h('div', { class: 'scanner-frame', 'aria-hidden': 'true' });
  const pillEl = h('span', { class: 'scanner-pill' }, '准备引擎…');
  const torchBtn = h('button', {
    type: 'button',
    class: 'scanner-tool-btn',
    hidden: true,
    'aria-label': '手电筒',
    'aria-pressed': 'false',
    onclick: async (e) => {
      e.stopPropagation();
      if (!videoTrack || !trackCaps.torch) return;
      const next = !torchOn;
      try {
        await videoTrack.applyConstraints({ advanced: [{ torch: next }] });
        torchOn = next;
        torchBtn.setAttribute('aria-pressed', String(torchOn));
      } catch { /* ignore unsupported torch toggle */ }
    },
  }, icon('flash', 18));

  const overlayTop = h('div', { class: 'scanner-overlay-top' }, pillEl, torchBtn);

  const zoomButtons = ZOOM_PRESETS.map((z) => {
    const btn = h('button', {
      type: 'button',
      class: 'scanner-zoom-btn',
      'aria-pressed': String(z === 1),
      onclick: (e) => {
        e.stopPropagation();
        applyZoom(z);
      },
    }, `${z}x`);
    return { z, btn };
  });
  const zoomBar = h('div', {
    class: 'scanner-zoom-bar',
    role: 'group',
    'aria-label': '变焦倍率',
  }, ...zoomButtons.map((item) => item.btn));

  const statusEl = h('p', { class: 'scanner-status' }, '正在请求高清后置摄像头…');

  const shutterBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    disabled: true,
    onclick: () => { captureHighResFrame(); },
  }, icon('camera', 18), '高清拍一帧');

  const stageEl = h('div', { class: 'scanner-stage' },
    video,
    frameEl,
    overlayTop,
    zoomBar);

  function updatePill() {
    const effective = currentHwZoom * currentDigitalZoom;
    pillEl.textContent = `${engineLabel} · ${formatZoomLabel(effective)}`;
  }

  function updateZoomButtons() {
    const effective = currentHwZoom * currentDigitalZoom;
    let closest = ZOOM_PRESETS[0];
    let minDiff = Math.abs(effective - closest);
    for (let i = 1; i < ZOOM_PRESETS.length; i++) {
      const d = Math.abs(effective - ZOOM_PRESETS[i]);
      if (d < minDiff) {
        minDiff = d;
        closest = ZOOM_PRESETS[i];
      }
    }
    for (const item of zoomButtons) {
      item.btn.setAttribute('aria-pressed', String(item.z === closest));
    }
  }

  function flushHwZoom() {
    if (!videoTrack || !hasHwZoom || closed) return;
    if (Math.abs(currentHwZoom - lastAppliedHwZoom) < 0.01) return;
    lastAppliedHwZoom = currentHwZoom;
    lastHwZoomAt = performance.now();
    videoTrack.applyConstraints({ advanced: [{ zoom: currentHwZoom }] }).catch(() => {});
  }

  function applyZoom(requested) {
    const maxTotal = Math.max(5, hwZoomMax);
    targetZoom = Math.min(maxTotal, Math.max(1, requested));
    currentHwZoom = hasHwZoom
      ? Math.min(hwZoomMax, Math.max(hwZoomMin, targetZoom))
      : 1;
    // 离散化数字变焦倍率，使预览 CSS .zoom-* 与 1:1 传感器采样裁剪严格一致
    currentDigitalZoom = snapDigitalZoom(targetZoom / currentHwZoom);

    for (const cls of ZOOM_CLASS_LIST) video.classList.remove(cls);
    video.classList.add(digitalZoomClass(currentDigitalZoom));

    if (hasHwZoom && videoTrack) {
      const elapsed = performance.now() - lastHwZoomAt;
      if (elapsed >= 60) {
        clearTimeout(zoomThrottleTimer);
        zoomThrottleTimer = 0;
        flushHwZoom();
      } else if (!zoomThrottleTimer) {
        zoomThrottleTimer = setTimeout(() => {
          zoomThrottleTimer = 0;
          flushHwZoom();
        }, 60 - elapsed);
      }
    }

    updatePill();
    updateZoomButtons();
  }

  function triggerRefocus() {
    frameEl.classList.remove('focusing');
    // Force reflow so rapid taps replay animation
    void frameEl.offsetWidth;
    frameEl.classList.add('focusing');
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => frameEl.classList.remove('focusing'), 460);

    if (videoTrack && Array.isArray(trackCaps.focusMode) && trackCaps.focusMode.includes('continuous')) {
      videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
  }

  // 点击舞台重新对焦
  stageEl.addEventListener('click', (e) => {
    if (isPinching) return;
    if (e.target && e.target.closest('button')) return;
    triggerRefocus();
  });

  // 双指捏合缩放
  stageEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      isPinching = true;
      pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
      pinchStartZoom = currentHwZoom * currentDigitalZoom;
    }
  }, { passive: true });

  stageEl.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDist > 0) {
      e.preventDefault();
      const dist = touchDistance(e.touches[0], e.touches[1]);
      if (dist > 0) {
        applyZoom(pinchStartZoom * (dist / pinchStartDist));
      }
    }
  }, { passive: false });

  stageEl.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      pinchStartDist = 0;
      setTimeout(() => { isPinching = false; }, 120);
    }
  }, { passive: true });

  stageEl.addEventListener('touchcancel', () => {
    pinchStartDist = 0;
    isPinching = false;
  }, { passive: true });

  const stopCamera = () => {
    closed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    clearTimeout(zoomThrottleTimer);
    clearTimeout(focusTimer);
    if (videoTrack && torchOn) {
      try { videoTrack.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {}); } catch { /* ignore */ }
      torchOn = false;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    videoTrack = null;
    imageCapture = null;
    video.srcObject = null;
    terminateWorker();
  };

  const content = h('div', { class: 'scanner-sheet' },
    h('div', { class: 'sheet-head' },
      h('h2', {}, '网页相机扫码'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '关闭', onclick: () => dlg.close() }, icon('x'))),
    stageEl,
    h('div', { class: 'scanner-foot' },
      statusEl,
      h('div', { class: 'scanner-actions' },
        shutterBtn,
        h('button', {
          type: 'button',
          class: 'btn tonal',
          onclick: () => {
            dlg.close();
            if (typeof onPickFile === 'function') onPickFile();
          },
        }, icon('image', 18), '相册'),
        h('button', {
          type: 'button',
          class: 'btn ghost',
          onclick: () => dlg.close(),
        }, '关闭'))));

  const dlg = openDialog(content, { label: '网页相机扫码', onClose: stopCamera });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  function finishWithResult(text) {
    if (!text || closed) return;
    dlg.close();
    if (typeof onResult === 'function') onResult(text);
  }

  async function captureHighResFrame() {
    if (closed || shutterBusy) return;
    shutterBusy = true;
    shutterBtn.disabled = true;
    const prevStatus = statusEl.textContent;
    statusEl.textContent = '正在拍摄高清原帧…';

    try {
      let text = '';
      if (imageCapture && typeof imageCapture.takePhoto === 'function') {
        try {
          const blob = await imageCapture.takePhoto();
          if (closed) return;
          // 优先尝试 Worker 原图直传，未命中则走完整 5 阶段多 ROI 流水线
          const workerOk = await ensureWorker();
          if (workerOk) {
            statusEl.textContent = '正在高清解析快门原图…';
            const res = await sendWorkerRequest({ type: 'decode-blob', blob });
            if (res && res.text) text = res.text;
          }
          if (!text && !closed) {
            text = await decodeImageFile(blob, {
              onProgress: (label) => {
                if (!closed) statusEl.textContent = label;
              },
            }).catch(() => '');
          }
        } catch { /* fallback to full-res video frame */ }
      }

      if (!text && !closed && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        statusEl.textContent = '正在满分辨率精扫当前帧…';
        text = await decodeSourceFiveStage(video, video.videoWidth, video.videoHeight, {
          onProgress: (label) => {
            if (!closed) statusEl.textContent = label;
          },
        });
      }

      if (text && !closed) {
        finishWithResult(text);
        return;
      }
      if (!closed) {
        statusEl.textContent = '未识别到二维码，可拉近倍率或轻点屏幕对焦后重试';
        setTimeout(() => {
          if (!closed && !shutterBusy) statusEl.textContent = prevStatus;
        }, 2200);
      }
    } catch {
      if (!closed) statusEl.textContent = '高清拍帧失败，请继续对准或使用相册识码';
    } finally {
      shutterBusy = false;
      if (!closed && videoTrack) shutterBtn.disabled = false;
    }
  }

  const loop = async (now) => {
    if (closed) return;
    rafId = requestAnimationFrame(loop);
    if (workerBusy || shutterBusy || now - lastScanAt < 80) return;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

    workerBusy = true;
    lastScanAt = now;

    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      // 1:1 传感器像素数字变焦视口（与 CSS .zoom-* 严格对齐）
      const viewW = vw / currentDigitalZoom;
      const viewH = vh / currentDigitalZoom;
      const viewX = (vw - viewW) / 2;
      const viewY = (vh - viewH) / 2;

      const slot = frameIndex % 4;
      frameIndex++;

      let sx = viewX;
      let sy = viewY;
      let sw = viewW;
      let sh = viewH;
      let maxDim = 960;
      let minDim = 0;
      let mode = 'fast';
      let useBarcodeDetector = true;

      if (slot === 0) {
        // 中心 60% ROI，原生 1:1 像素，上限 960px
        sw = viewW * 0.60;
        sh = viewH * 0.60;
        sx = viewX + (viewW - sw) / 2;
        sy = viewY + (viewH - sh) / 2;
        maxDim = 960;
      } else if (slot === 1) {
        // 中心 35% 长焦 ROI，若边长 < 320px 则等比放大至 480px
        sw = viewW * 0.35;
        sh = viewH * 0.35;
        sx = viewX + (viewW - sw) / 2;
        sy = viewY + (viewH - sh) / 2;
        maxDim = 960;
        minDim = Math.max(sw, sh) < 320 ? 480 : 0;
      } else if (slot === 2) {
        // 完整视口，上限 1080px
        maxDim = 1080;
      } else {
        // 中心 50% ROI，上限 720px，Worker 对比度拉伸 + 锐化增强模式
        sw = viewW * 0.50;
        sh = viewH * 0.50;
        sx = viewX + (viewW - sw) / 2;
        sy = viewY + (viewH - sh) / 2;
        maxDim = 720;
        mode = 'enhanced';
        useBarcodeDetector = false;
      }

      drawRegion(canvas, ctx, video, sx, sy, sw, sh, maxDim, minDim);
      const text = await decodeCanvas(canvas, ctx, { mode, useBarcodeDetector });
      if (text && !closed) {
        finishWithResult(text);
        return;
      }
    } catch { /* continue scanning */ } finally {
      workerBusy = false;
    }
  };

  async function requestCameraStream() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 },
          focusMode: { ideal: 'continuous' },
        },
        audio: false,
      });
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError' || err.name === 'NotFoundError')) {
        throw err;
      }
      return navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    }
  }

  (async () => {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      pillEl.textContent = '不支持相机';
      statusEl.textContent = '当前环境不支持网页摄像头（需 HTTPS），请改用下方「相册」。';
      return;
    }
    try {
      // 并行预热解码引擎与请求相机流
      const [workerOk, detector, mediaStream] = await Promise.all([
        ensureWorker(),
        getBarcodeDetector(),
        requestCameraStream(),
      ]);

      if (closed) {
        for (const t of mediaStream.getTracks()) t.stop();
        return;
      }

      stream = mediaStream;
      if (workerOk) {
        engineLabel = detector ? '原生+WASM' : 'WASM 高清';
      } else {
        engineLabel = detector ? '原生+兼容' : '兼容模式';
        if (!detector) {
          statusEl.textContent = '正在加载兼容二维码解码器…';
          await ensureJsQR();
        }
      }
      if (closed) {
        stopCamera();
        return;
      }

      video.srcObject = stream;
      await video.play();

      videoTrack = stream.getVideoTracks()[0] || null;
      if (videoTrack) {
        if (typeof videoTrack.getCapabilities === 'function') {
          try { trackCaps = videoTrack.getCapabilities() || {}; } catch { trackCaps = {}; }
        }
        if (trackCaps.zoom && typeof trackCaps.zoom.max === 'number' && trackCaps.zoom.max > 1) {
          hasHwZoom = true;
          hwZoomMin = typeof trackCaps.zoom.min === 'number' ? Math.max(1, trackCaps.zoom.min) : 1;
          hwZoomMax = trackCaps.zoom.max;
        }
        if (Array.isArray(trackCaps.focusMode) && trackCaps.focusMode.includes('continuous')) {
          videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        }
        if (trackCaps.torch === true) {
          torchBtn.hidden = false;
        }
        if (typeof globalThis.ImageCapture === 'function') {
          try { imageCapture = new globalThis.ImageCapture(videoTrack); } catch { imageCapture = null; }
        }
        shutterBtn.disabled = false;
      }

      applyZoom(1);
      statusEl.textContent = '对准教室大屏二维码，支持双指缩放与点击对焦';
      rafId = requestAnimationFrame(loop);
    } catch (err) {
      if (closed) return;
      pillEl.textContent = '相机受限';
      const msg = err && err.name === 'NotAllowedError'
        ? '未授予摄像头权限，请在浏览器设置中允许或使用「相册」。'
        : `无法打开摄像头（${(err && err.message) || '权限受限'}），可改用「相册」。`;
      statusEl.textContent = msg;
    }
  })();

  return dlg;
}
