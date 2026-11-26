// Web 扫码器：自托管 zxing-wasm@3.1.7 Classic Worker + 原生 BarcodeDetector + 自适应低功耗轮询
// + 有界内存相册识码（支持 AbortSignal）+ 确定性相机生命周期管理。

import { h, icon, openDialog } from './dom.js';

const URL_RE = /https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCT_RE = /[.,;!?)\]}'"，。；！？）】》]+$/;

const DIGITAL_STEPS = [1, 1.5, 2, 3, 5];
const ZOOM_PRESETS = [1, 2, 3, 5];
const ZOOM_CLASS_LIST = ['zoom-1', 'zoom-1-5', 'zoom-2', 'zoom-3', 'zoom-5'];

const MAX_PHOTO_DIM = 1600;
const PHOTO_BUDGET_MS = 10000;

const TIMEOUT_INIT_MS = 10000;
const TIMEOUT_LIVE_MS = 2000;
const TIMEOUT_PHOTO_MS = 6000;
const IDLE_TERMINATE_MS = 30000;
const MAX_WORKER_RESTARTS = 2;

// 2x2 重叠象限（60% 宽×高，偏移 0 / 0.4）
const QUADRANTS = [
  [0, 0],
  [0.4, 0],
  [0, 0.4],
  [0.4, 0.4],
];

let barcodeDetectorPromise = null;
let activeCameraScanner = null;

export function extractUrl(text) {
  const m = URL_RE.exec(String(text || '').trim());
  if (!m) return '';
  return m[0].replace(TRAILING_PUNCT_RE, '');
}

export function getScannerSupport() {
  return {
    camera: Boolean(
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function',
    ),
    barcodeDetector: typeof globalThis.BarcodeDetector === 'function',
    wasmWorker:
      typeof globalThis.Worker === 'function' &&
      typeof globalThis.WebAssembly === 'object',
  };
}

function createAbortError() {
  return new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw createAbortError();
}

function yieldToMain(signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) reject(createAbortError());
      else resolve();
    }, 0);
    function onAbort() {
      clearTimeout(timer);
      reject(createAbortError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function zeroCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
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

class ScannerWorkerClient {
  constructor() {
    this.worker = null;
    this.initPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.idleTimer = 0;
    this.restarts = 0;
  }

  get supported() {
    return (
      typeof globalThis.Worker === 'function' &&
      typeof globalThis.WebAssembly === 'object'
    );
  }

  isIdle() {
    return this.pending.size === 0;
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = 0;
    }
  }

  scheduleIdleTerminate() {
    this.clearIdleTimer();
    if (!this.worker || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = 0;
      if (this.pending.size === 0 && !activeCameraScanner) {
        this.terminate('Worker 空闲回收', false);
      }
    }, IDLE_TERMINATE_MS);
  }

  terminate(reason = 'Worker 已终止', countAsFailure = false) {
    this.clearIdleTimer();
    const err = new Error(reason);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      if (entry.onAbort && entry.signal) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      entry.reject(err);
    }
    this.pending.clear();
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* ignore */ }
      this.worker = null;
    }
    this.initPromise = null;
    if (countAsFailure) {
      this.restarts++;
    }
  }

  resetRestarts() {
    this.restarts = 0;
  }

  dispose() {
    this.terminate('资源已释放', false);
    this.restarts = 0;
  }

  async ensureReady(signal) {
    throwIfAborted(signal);
    if (!this.supported) return false;
    if (this.restarts > MAX_WORKER_RESTARTS) return false;
    this.clearIdleTimer();
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      let w = null;
      try {
        w = new Worker('/scanner-worker.js');
        this.worker = w;
        w.onmessage = (event) => {
          const msg = event.data || {};
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (entry.onAbort && entry.signal) {
            entry.signal.removeEventListener('abort', entry.onAbort);
          }
          entry.resolve(msg);
          if (this.pending.size === 0) this.scheduleIdleTerminate();
        };
        w.onerror = (err) => {
          if (this.worker === w) {
            this.terminate((err && err.message) || 'Worker 运行异常', true);
          }
        };
        const res = await this._sendRaw({ type: 'init' }, [], TIMEOUT_INIT_MS, signal);
        if (!res || !res.ok || this.worker !== w) {
          if (this.worker === w) {
            this.terminate((res && res.error) || 'WASM 初始化失败', true);
          }
          return false;
        }
        return true;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          if (this.worker === w) this.terminate('已取消', false);
          throw err;
        }
        if (!w || this.worker === w) {
          this.terminate((err && err.message) || 'WASM 初始化异常', true);
        }
        return false;
      }
    })();

    return this.initPromise;
  }

  _sendRaw(payload, transfer, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(createAbortError());
        return;
      }
      if (!this.worker) {
        reject(new Error('Worker 不可用'));
        return;
      }
      this.clearIdleTimer();
      const id = this.nextId++;
      const w = this.worker;

      const entry = {
        resolve,
        reject,
        signal,
        onAbort: null,
        timer: 0,
      };

      entry.timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (entry.onAbort && signal) signal.removeEventListener('abort', entry.onAbort);
        if (this.worker === w) {
          this.terminate(`Worker 请求超时 (${timeoutMs}ms)`, true);
        }
        reject(new Error('Worker 解码超时'));
      }, timeoutMs);

      if (signal) {
        entry.onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          reject(createAbortError());
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      this.pending.set(id, entry);
      try {
        w.postMessage({ ...payload, id }, transfer);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (entry.onAbort && signal) signal.removeEventListener('abort', entry.onAbort);
        reject(err);
      }
    });
  }

  async decodeRgba(width, height, buffer, profile, signal) {
    throwIfAborted(signal);
    const timeoutMs = profile.startsWith('photo-') ? TIMEOUT_PHOTO_MS : TIMEOUT_LIVE_MS;

    const ready = await this.ensureReady(signal);
    if (!ready) return '';

    try {
      const res = await this._sendRaw(
        { type: 'decode-rgba', width, height, buffer, profile },
        [buffer],
        timeoutMs,
        signal,
      );
      if (res && res.ok) {
        this.restarts = 0;
        return res.text || '';
      }
      return '';
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      return '';
    }
  }

  sendReset() {
    if (!this.worker || this.pending.size > 0) return;
    this._sendRaw({ type: 'reset' }, [], TIMEOUT_LIVE_MS, null).catch(() => {});
  }
}

const workerClient = new ScannerWorkerClient();

export function disposeScannerResources() {
  workerClient.dispose();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (activeCameraScanner) {
      activeCameraScanner._closeWithReason('pagehide');
    }
    disposeScannerResources();
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !activeCameraScanner && workerClient.isIdle()) {
      workerClient.terminate('页面切至后台释放空闲 Worker', false);
    }
  });
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
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(source, sx, sy, safeW, safeH, 0, 0, dw, dh);
}

async function decodeCanvasWithWorker(canvas, ctx, profile, signal) {
  throwIfAborted(signal);
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return '';
  const imgData = ctx.getImageData(0, 0, w, h);
  return workerClient.decodeRgba(w, h, imgData.data.buffer, profile, signal);
}

function loadImageElement(blobUrl, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createAbortError());
      return;
    }
    const img = new Image();
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      img.src = '';
      reject(createAbortError());
    };
    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(new Error('图片读取失败'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    img.src = blobUrl;
  });
}

async function loadCappedImageSource(file, signal) {
  throwIfAborted(signal);
  const revokeUrl = URL.createObjectURL(file);
  let bitmap = null;
  let downscaleCanvas = null;

  try {
    const img = await loadImageElement(revokeUrl, signal);
    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;
    if (!natW || !natH) throw new Error('图片尺寸无效');

    const longSide = Math.max(natW, natH);
    const needsResize = longSide > MAX_PHOTO_DIM;
    const targetW = needsResize ? Math.max(1, Math.round((natW * MAX_PHOTO_DIM) / longSide)) : natW;
    const targetH = needsResize ? Math.max(1, Math.round((natH * MAX_PHOTO_DIM) / longSide)) : natH;

    if (typeof createImageBitmap === 'function') {
      try {
        bitmap = needsResize
          ? await createImageBitmap(file, {
              resizeWidth: targetW,
              resizeHeight: targetH,
              resizeQuality: 'medium',
            })
          : await createImageBitmap(file);
        throwIfAborted(signal);
        return {
          source: bitmap,
          width: bitmap.width || targetW,
          height: bitmap.height || targetH,
          release: () => {
            if (bitmap && typeof bitmap.close === 'function') bitmap.close();
            URL.revokeObjectURL(revokeUrl);
          },
        };
      } catch (err) {
        if (err && err.name === 'AbortError') {
          if (bitmap && typeof bitmap.close === 'function') bitmap.close();
          throw err;
        }
        bitmap = null;
      }
    }

    if (needsResize) {
      downscaleCanvas = document.createElement('canvas');
      downscaleCanvas.width = targetW;
      downscaleCanvas.height = targetH;
      const dctx = downscaleCanvas.getContext('2d');
      dctx.imageSmoothingEnabled = true;
      dctx.imageSmoothingQuality = 'medium';
      dctx.drawImage(img, 0, 0, natW, natH, 0, 0, targetW, targetH);
      return {
        source: downscaleCanvas,
        width: targetW,
        height: targetH,
        release: () => {
          zeroCanvas(downscaleCanvas);
          URL.revokeObjectURL(revokeUrl);
        },
      };
    }

    return {
      source: img,
      width: natW,
      height: natH,
      release: () => {
        URL.revokeObjectURL(revokeUrl);
      },
    };
  } catch (err) {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    zeroCanvas(downscaleCanvas);
    URL.revokeObjectURL(revokeUrl);
    throw err;
  }
}

async function decodeSourceBudgeted(source, srcW, srcH, { signal, onProgress } = {}) {
  throwIfAborted(signal);
  const detector = await getBarcodeDetector();
  throwIfAborted(signal);

  const deadline = performance.now() + PHOTO_BUDGET_MS;
  const total = detector ? 9 : 8;
  let step = 0;

  const report = (label) => {
    step++;
    if (typeof onProgress === 'function') {
      try {
        onProgress({ step, total, label });
      } catch { /* ignore */ }
    }
  };

  if (detector) {
    report('正在快速预检原图…');
    try {
      const codes = await detector.detect(source);
      throwIfAborted(signal);
      if (codes && codes.length > 0 && codes[0].rawValue) {
        return codes[0].rawValue.trim();
      }
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
    }
    await yieldToMain(signal);
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const stages = [
    { label: '正在解析高清原图…', sx: 0, sy: 0, sw: srcW, sh: srcH, maxDim: 1400, minDim: 0, profile: 'photo-fast' },
    {
      label: '正在精扫中心区域…',
      sx: srcW * 0.225,
      sy: srcH * 0.225,
      sw: srcW * 0.55,
      sh: srcH * 0.55,
      maxDim: 960,
      minDim: 0,
      profile: 'photo-fast',
    },
    {
      label: '正在精扫中心特写…',
      sx: srcW * 0.325,
      sy: srcH * 0.325,
      sw: srcW * 0.35,
      sh: srcH * 0.35,
      maxDim: 960,
      minDim: 480,
      profile: 'photo-fast',
    },
    ...QUADRANTS.map(([ox, oy]) => ({
      label: '正在分区扫描…',
      sx: srcW * ox,
      sy: srcH * oy,
      sw: srcW * 0.6,
      sh: srcH * 0.6,
      maxDim: 960,
      minDim: 0,
      profile: 'photo-fast',
    })),
    {
      label: '正在增强对比度识别…',
      sx: srcW * 0.25,
      sy: srcH * 0.25,
      sw: srcW * 0.5,
      sh: srcH * 0.5,
      maxDim: 800,
      minDim: 0,
      profile: 'photo-enhanced',
    },
  ];

  try {
    for (let i = 0; i < stages.length; i++) {
      throwIfAborted(signal);
      if (i > 0 && performance.now() >= deadline) break;

      const st = stages[i];
      report(st.label);
      drawRegion(canvas, ctx, source, st.sx, st.sy, st.sw, st.sh, st.maxDim, st.minDim);
      const text = await decodeCanvasWithWorker(canvas, ctx, st.profile, signal);
      if (text) return text;

      if (i < stages.length - 1) {
        await yieldToMain(signal);
      }
    }
    return '';
  } finally {
    zeroCanvas(canvas);
  }
}

export async function decodeImageFile(file, { signal, onProgress } = {}) {
  throwIfAborted(signal);
  if (!file) throw new Error('未选择图片');

  const loaded = await loadCappedImageSource(file, signal);
  try {
    const text = await decodeSourceBudgeted(loaded.source, loaded.width, loaded.height, {
      signal,
      onProgress,
    });
    throwIfAborted(signal);
    if (!text) throw new Error('未在图片中识别到二维码，请对准清晰二维码重试');
    return text;
  } finally {
    loaded.release();
    workerClient.sendReset();
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

export function openCameraScanner({ onResult, onPickFile, onClose } = {}) {
  if (activeCameraScanner) {
    activeCameraScanner.close();
  }

  workerClient.resetRestarts();

  let state = 'starting';
  let closeReason = 'user';
  let onCloseFired = false;
  let sessionAbort = new AbortController();
  let captureAbort = null;
  let startGen = 0;
  let scanGen = 0;

  let stream = null;
  let videoTrack = null;
  let trackCaps = {};
  let imageCapture = null;
  let detector = null;
  let workerReady = false;

  let scanTimer = 0;
  let vfcId = 0;
  let frameBusy = false;
  let frameIndex = 0;
  let enhancedToggle = false;
  let lastDecodeMs = 120;
  let intentionalTrackStop = false;

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
  let pinchTimer = 0;
  let statusTimer = 0;
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
      if (!videoTrack || !trackCaps.torch || state === 'closed') return;
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

  const retryBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    hidden: true,
    onclick: () => { resume(); },
  }, '重新开启相机');

  const stageEl = h('div', { class: 'scanner-stage' },
    video,
    frameEl,
    overlayTop,
    zoomBar);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

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
    if (!videoTrack || !hasHwZoom || state === 'closed' || state === 'paused') return;
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
    void frameEl.offsetWidth;
    frameEl.classList.add('focusing');
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      focusTimer = 0;
      frameEl.classList.remove('focusing');
    }, 460);

    if (videoTrack && Array.isArray(trackCaps.focusMode) && trackCaps.focusMode.includes('continuous')) {
      videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
  }

  stageEl.addEventListener('click', (e) => {
    if (isPinching) return;
    if (e.target && e.target.closest('button')) return;
    triggerRefocus();
  });

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
      clearTimeout(pinchTimer);
      pinchTimer = setTimeout(() => {
        pinchTimer = 0;
        isPinching = false;
      }, 120);
    }
  }, { passive: true });

  stageEl.addEventListener('touchcancel', () => {
    pinchStartDist = 0;
    clearTimeout(pinchTimer);
    pinchTimer = 0;
    isPinching = false;
  }, { passive: true });

  function cancelScanSchedule() {
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = 0;
    }
    if (vfcId && typeof video.cancelVideoFrameCallback === 'function') {
      try { video.cancelVideoFrameCallback(vfcId); } catch { /* ignore */ }
      vfcId = 0;
    }
  }

  function clearAllTimers() {
    cancelScanSchedule();
    clearTimeout(zoomThrottleTimer);
    zoomThrottleTimer = 0;
    clearTimeout(focusTimer);
    focusTimer = 0;
    clearTimeout(pinchTimer);
    pinchTimer = 0;
    clearTimeout(statusTimer);
    statusTimer = 0;
  }

  function onTrackEnded() {
    if (intentionalTrackStop || state === 'closed' || state === 'paused') return;
    cancelScanSchedule();
    scanGen++;
    state = 'paused';
    shutterBtn.disabled = true;
    retryBtn.hidden = false;
    pillEl.textContent = '相机已断开';
    statusEl.textContent = '摄像头连接已中断，可点击「重新开启相机」或改用「相册」。';
    zeroCanvas(canvas);
  }

  function stopTracks() {
    intentionalTrackStop = true;
    if (videoTrack) {
      videoTrack.removeEventListener('ended', onTrackEnded);
      if (torchOn) {
        try { videoTrack.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {}); } catch { /* ignore */ }
        torchOn = false;
        torchBtn.setAttribute('aria-pressed', 'false');
      }
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      stream = null;
    }
    videoTrack = null;
    trackCaps = {};
    imageCapture = null;
    video.srcObject = null;
    zeroCanvas(canvas);
    intentionalTrackStop = false;
  }

  function onVisibilityChange() {
    if (state === 'closed') return;
    if (document.visibilityState === 'hidden') {
      pause();
    } else if (document.visibilityState === 'visible' && state === 'paused') {
      resume();
    }
  }

  function cleanup() {
    if (state === 'closed') return;
    state = 'closed';
    startGen++;
    scanGen++;
    sessionAbort.abort();
    if (captureAbort) {
      captureAbort.abort();
      captureAbort = null;
    }
    clearAllTimers();
    stopTracks();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (activeCameraScanner === handle) {
      activeCameraScanner = null;
    }
    workerClient.sendReset();
    workerClient.scheduleIdleTerminate();
    if (!onCloseFired) {
      onCloseFired = true;
      if (typeof onClose === 'function') {
        try { onClose(closeReason); } catch { /* ignore */ }
      }
    }
  }

  function closeWithReason(reason) {
    if (state === 'closed') return;
    closeReason = reason;
    dlg.close();
  }

  const content = h('div', { class: 'scanner-sheet' },
    h('div', { class: 'sheet-head' },
      h('h2', {}, '网页相机扫码'),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        'aria-label': '关闭',
        onclick: () => closeWithReason('user'),
      }, icon('x'))),
    stageEl,
    h('div', { class: 'scanner-foot' },
      statusEl,
      h('div', { class: 'scanner-actions' },
        shutterBtn,
        retryBtn,
        h('button', {
          type: 'button',
          class: 'btn tonal',
          onclick: () => {
            closeWithReason('pick-file');
            if (typeof onPickFile === 'function') onPickFile();
          },
        }, icon('image', 18), '相册'),
        h('button', {
          type: 'button',
          class: 'btn ghost',
          onclick: () => closeWithReason('user'),
        }, '关闭'))));

  const dlg = openDialog(content, { label: '网页相机扫码', onClose: cleanup });

  function finishWithResult(text) {
    if (!text || state === 'closed') return;
    closeWithReason('result');
    if (typeof onResult === 'function') onResult(text);
  }

  function scheduleNextScan(delayMs) {
    if (state !== 'scanning') return;
    cancelScanSchedule();
    const myGen = scanGen;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      if (state !== 'scanning' || myGen !== scanGen) return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        vfcId = video.requestVideoFrameCallback(() => {
          vfcId = 0;
          if (state === 'scanning' && myGen === scanGen) runLiveFrame(myGen);
        });
      } else {
        runLiveFrame(myGen);
      }
    }, delayMs);
  }

  async function runLiveFrame(myGen) {
    if (state !== 'scanning' || myGen !== scanGen) return;
    if (frameBusy || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      scheduleNextScan(120);
      return;
    }

    frameBusy = true;
    const t0 = performance.now();

    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const viewW = vw / currentDigitalZoom;
      const viewH = vh / currentDigitalZoom;
      const viewX = (vw - viewW) / 2;
      const viewY = (vh - viewH) / 2;

      const slot = frameIndex % 4;
      frameIndex++;

      let text = '';

      if (slot === 0 && detector) {
        // 仅跑原生 BarcodeDetector（直接读 <video>，零 canvas 拷贝），绝不与 WASM 同帧并行
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length > 0 && codes[0].rawValue) {
            text = codes[0].rawValue.trim();
          }
        } catch { /* ignore */ }
      } else if (workerReady) {
        let sx = viewX;
        let sy = viewY;
        let sw = viewW;
        let sh = viewH;
        let maxDim = 960;
        let minDim = 0;
        let profile = 'live-fast';

        if (slot === 0) {
          maxDim = 960;
        } else if (slot === 1) {
          sw = viewW * 0.55;
          sh = viewH * 0.55;
          sx = viewX + (viewW - sw) / 2;
          sy = viewY + (viewH - sh) / 2;
          maxDim = 800;
        } else if (slot === 2) {
          sw = viewW * 0.35;
          sh = viewH * 0.35;
          sx = viewX + (viewW - sw) / 2;
          sy = viewY + (viewH - sh) / 2;
          maxDim = 720;
          minDim = Math.max(sw, sh) < 320 ? 480 : 0;
        } else {
          sw = viewW * 0.5;
          sh = viewH * 0.5;
          sx = viewX + (viewW - sw) / 2;
          sy = viewY + (viewH - sh) / 2;
          maxDim = 640;
          enhancedToggle = !enhancedToggle;
          profile = enhancedToggle ? 'live-enhanced-local' : 'live-enhanced-global';
        }

        drawRegion(canvas, ctx, video, sx, sy, sw, sh, maxDim, minDim);
        text = await decodeCanvasWithWorker(canvas, ctx, profile, sessionAbort.signal);
      }

      if (text && state === 'scanning' && myGen === scanGen) {
        finishWithResult(text);
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    } finally {
      frameBusy = false;
      lastDecodeMs = Math.max(1, performance.now() - t0);
    }

    if (state === 'scanning' && myGen === scanGen) {
      const nextDelay = Math.max(120, Math.min(400, Math.round(lastDecodeMs * 1.5)));
      scheduleNextScan(nextDelay);
    }
  }

  async function captureHighResFrame() {
    if (state !== 'scanning') return;
    state = 'capturing';
    cancelScanSchedule();
    scanGen++;
    shutterBtn.disabled = true;
    clearTimeout(statusTimer);
    statusTimer = 0;

    captureAbort = new AbortController();
    const sig = captureAbort.signal;
    const prevStatus = statusEl.textContent;
    statusEl.textContent = '正在拍摄高清原帧…';

    try {
      let text = '';
      let takePhotoFailed = false;

      if (imageCapture && typeof imageCapture.takePhoto === 'function') {
        try {
          const blob = await imageCapture.takePhoto();
          throwIfAborted(sig);
          if (state !== 'capturing') return;
          text = await decodeImageFile(blob, {
            signal: sig,
            onProgress: (p) => {
              if (state === 'capturing') statusEl.textContent = p.label;
            },
          }).catch((err) => {
            if (err && err.name === 'AbortError') throw err;
            return '';
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          takePhotoFailed = true;
        }
      } else {
        takePhotoFailed = true;
      }

      // 仅当 takePhoto 不可用或抛错时，回退到当前视频帧的预算式解码
      if (takePhotoFailed && !text && state === 'capturing' && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        statusEl.textContent = '正在精扫当前高清帧…';
        text = await decodeSourceBudgeted(video, video.videoWidth, video.videoHeight, {
          signal: sig,
          onProgress: (p) => {
            if (state === 'capturing') statusEl.textContent = p.label;
          },
        }).catch((err) => {
          if (err && err.name === 'AbortError') throw err;
          return '';
        });
      }

      if (text && state === 'capturing') {
        finishWithResult(text);
        return;
      }

      if (state === 'capturing') {
        statusEl.textContent = '未识别到二维码，可拉近倍率或轻点屏幕对焦后重试';
        statusTimer = setTimeout(() => {
          statusTimer = 0;
          if (state === 'scanning') statusEl.textContent = prevStatus;
        }, 2200);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (state === 'capturing') {
        statusEl.textContent = '高清拍帧失败，请继续对准或使用相册识码';
      }
    } finally {
      captureAbort = null;
      if (state === 'capturing') {
        state = 'scanning';
        if (videoTrack) shutterBtn.disabled = false;
        scheduleNextScan(150);
      }
    }
  }

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

  async function startCamera() {
    const myStartGen = ++startGen;
    state = 'starting';
    retryBtn.hidden = true;
    shutterBtn.disabled = true;

    const support = getScannerSupport();
    if (!support.camera) {
      pillEl.textContent = '不支持相机';
      statusEl.textContent = '当前环境不支持网页摄像头（需 HTTPS），请改用下方「相册」。';
      return;
    }

    if (!support.barcodeDetector && !support.wasmWorker) {
      pillEl.textContent = '不支持解码';
      statusEl.textContent = '当前浏览器不支持二维码解码，请改用现代浏览器或系统相机。';
      return;
    }

    statusEl.textContent = '正在请求高清后置摄像头…';

    let mediaStream = null;
    try {
      const [wOk, det, acquired] = await Promise.all([
        workerClient.ensureReady(sessionAbort.signal).catch(() => false),
        getBarcodeDetector(),
        requestCameraStream(),
      ]);
      mediaStream = acquired;

      if (state === 'closed' || sessionAbort.signal.aborted || myStartGen !== startGen) {
        for (const t of mediaStream.getTracks()) t.stop();
        return;
      }

      workerReady = wOk;
      detector = det;
      stream = mediaStream;
      mediaStream = null;

      if (workerReady) {
        engineLabel = detector ? '原生+WASM' : 'WASM 高清';
      } else if (detector) {
        engineLabel = '原生引擎';
      } else {
        engineLabel = '解码不可用';
        statusEl.textContent = '解码引擎初始化失败，请刷新重试或改用「相册」。';
        stopTracks();
        return;
      }

      video.srcObject = stream;
      await video.play();

      if (state === 'closed' || sessionAbort.signal.aborted || myStartGen !== startGen) {
        stopTracks();
        return;
      }

      videoTrack = stream.getVideoTracks()[0] || null;
      hasHwZoom = false;
      hwZoomMin = 1;
      hwZoomMax = 1;
      torchBtn.hidden = true;

      if (videoTrack) {
        videoTrack.addEventListener('ended', onTrackEnded);
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

      applyZoom(targetZoom);
      state = 'scanning';
      statusEl.textContent = '对准教室大屏二维码，支持双指缩放与点击对焦';
      scheduleNextScan(120);
    } catch (err) {
      if (mediaStream) {
        for (const t of mediaStream.getTracks()) t.stop();
      }
      if (state === 'closed' || (err && err.name === 'AbortError') || myStartGen !== startGen) return;
      pillEl.textContent = '相机受限';
      const msg = err && err.name === 'NotAllowedError'
        ? '未授予摄像头权限，请在浏览器设置中允许或使用「相册」。'
        : `无法打开摄像头（${(err && err.message) || '权限受限'}），可改用「相册」。`;
      statusEl.textContent = msg;
      retryBtn.hidden = false;
    }
  }

  function pause() {
    if (state === 'closed' || state === 'paused') return;
    state = 'paused';
    startGen++;
    scanGen++;
    if (captureAbort) {
      captureAbort.abort();
      captureAbort = null;
    }
    clearAllTimers();
    stopTracks();
    shutterBtn.disabled = true;
    pillEl.textContent = '已暂停';
  }

  async function resume() {
    if (state === 'closed') return;
    if (state === 'scanning' || state === 'starting') return;
    if (sessionAbort.signal.aborted) {
      sessionAbort = new AbortController();
    }
    await startCamera();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);

  const handle = {
    get el() { return dlg.el; },
    get state() { return state; },
    pause,
    resume,
    close: () => closeWithReason('user'),
    _closeWithReason: closeWithReason,
  };

  activeCameraScanner = handle;
  startCamera();

  return handle;
}
