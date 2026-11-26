// Zero-freeze Web QR Scanner: self-hosted zxing-wasm@3.1.7 Classic Worker + native BarcodeDetector
// + adaptive low-power polling + bounded-memory photo decode (AbortSignal) + deterministic camera controller.

import type { DecodeProgress, ScannerSupport, TorchInfo, ZoomInfo } from '../types/protocol';

const URL_RE = /https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCT_RE = /[.,;!?)\]}'"，。；！？）】》]+$/;

const DIGITAL_STEPS = [1, 1.5, 2, 3, 5];

const MAX_PHOTO_DIM = 1600;
const PHOTO_BUDGET_MS = 10000;

const TIMEOUT_INIT_MS = 10000;
const TIMEOUT_LIVE_MS = 2000;
const TIMEOUT_PHOTO_MS = 6000;
const IDLE_TERMINATE_MS = 30000;
const MAX_WORKER_RESTARTS = 2;

const QUADRANTS: Array<[number, number]> = [
  [0, 0],
  [0.4, 0],
  [0, 0.4],
  [0.4, 0.4],
];

interface BarcodeDetectorInstance {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>>;
}

interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

interface ImageCaptureInstance {
  takePhoto(): Promise<Blob>;
}

interface ImageCaptureCtor {
  new (track: MediaStreamTrack): ImageCaptureInstance;
}

interface ExtendedCapabilities extends MediaTrackCapabilities {
  zoom?: { min?: number; max?: number; step?: number };
  torch?: boolean;
  focusMode?: string[];
}

let barcodeDetectorPromise: Promise<BarcodeDetectorInstance | null> | null = null;
let activeController: CameraController | null = null;

export function extractUrl(text: string): string {
  const m = URL_RE.exec(String(text || '').trim());
  if (!m) return '';
  return m[0].replace(TRAILING_PUNCT_RE, '');
}

export function getScannerSupport(): ScannerSupport {
  const g = globalThis as unknown as {
    BarcodeDetector?: BarcodeDetectorCtor;
    Worker?: typeof Worker;
    WebAssembly?: typeof WebAssembly;
  };
  return {
    camera: Boolean(
      typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function',
    ),
    barcodeDetector: typeof g.BarcodeDetector === 'function',
    wasmWorker: typeof g.Worker === 'function' && typeof g.WebAssembly === 'object',
  };
}

function createAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal && signal.aborted) throw createAbortError();
}

function yieldToMain(signal?: AbortSignal | null): Promise<void> {
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

function zeroCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

async function getBarcodeDetector(): Promise<BarcodeDetectorInstance | null> {
  if (barcodeDetectorPromise) return barcodeDetectorPromise;
  barcodeDetectorPromise = (async () => {
    const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
      .BarcodeDetector;
    if (typeof Ctor !== 'function') return null;
    try {
      if (typeof Ctor.getSupportedFormats === 'function') {
        const formats = await Ctor.getSupportedFormats();
        if (!formats.includes('qr_code')) return null;
      }
      return new Ctor({ formats: ['qr_code'] });
    } catch {
      return null;
    }
  })();
  return barcodeDetectorPromise;
}

interface WorkerResponseMessage {
  id: number;
  ok: boolean;
  text?: string;
  error?: string;
  engine?: string;
  elapsedMs?: number;
}

interface PendingWorkerEntry {
  resolve: (msg: WorkerResponseMessage) => void;
  reject: (err: Error) => void;
  signal: AbortSignal | null | undefined;
  onAbort: (() => void) | null;
  timer: ReturnType<typeof setTimeout>;
}

class ScannerWorkerClient {
  private worker: Worker | null = null;
  private initPromise: Promise<boolean> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingWorkerEntry>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;

  get supported(): boolean {
    return typeof globalThis.Worker === 'function' && typeof globalThis.WebAssembly === 'object';
  }

  isIdle(): boolean {
    return this.pending.size === 0;
  }

  clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  scheduleIdleTerminate(): void {
    this.clearIdleTimer();
    if (!this.worker || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0 && !activeController) {
        this.terminate('Worker 空闲回收', false);
      }
    }, IDLE_TERMINATE_MS);
  }

  terminate(reason = 'Worker 已终止', countAsFailure = false): void {
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
      try {
        this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }
    this.initPromise = null;
    if (countAsFailure) {
      this.restarts++;
    }
  }

  resetRestarts(): void {
    this.restarts = 0;
  }

  dispose(): void {
    this.terminate('资源已释放', false);
    this.restarts = 0;
  }

  async ensureReady(signal?: AbortSignal | null): Promise<boolean> {
    throwIfAborted(signal);
    if (!this.supported) return false;
    if (this.restarts > MAX_WORKER_RESTARTS) return false;
    this.clearIdleTimer();
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      let w: Worker | null = null;
      try {
        w = new Worker(new URL('./scanner-worker.ts', import.meta.url));
        this.worker = w;
        w.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
          const msg = event.data || ({} as WorkerResponseMessage);
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
        w.onerror = (err: ErrorEvent) => {
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
      } catch (err: unknown) {
        if (err && (err as { name?: string }).name === 'AbortError') {
          if (this.worker === w) this.terminate('已取消', false);
          throw err;
        }
        if (!w || this.worker === w) {
          this.terminate(
            (err instanceof Error ? err.message : String(err)) || 'WASM 初始化异常',
            true,
          );
        }
        return false;
      }
    })();

    return this.initPromise;
  }

  private _sendRaw(
    payload: Record<string, unknown>,
    transfer: Transferable[],
    timeoutMs: number,
    signal?: AbortSignal | null,
  ): Promise<WorkerResponseMessage> {
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

      const entry: PendingWorkerEntry = {
        resolve,
        reject,
        signal,
        onAbort: null,
        timer: setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          if (entry.onAbort && signal) signal.removeEventListener('abort', entry.onAbort);
          if (this.worker === w) {
            this.terminate(`Worker 请求超时 (${timeoutMs}ms)`, true);
          }
          reject(new Error('Worker 解码超时'));
        }, timeoutMs),
      };

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
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async decodeRgba(
    width: number,
    height: number,
    buffer: ArrayBuffer,
    profile: string,
    signal?: AbortSignal | null,
  ): Promise<string> {
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
    } catch (err: unknown) {
      if (err && (err as { name?: string }).name === 'AbortError') throw err;
      return '';
    }
  }

  sendReset(): void {
    if (!this.worker || this.pending.size > 0) return;
    this._sendRaw({ type: 'reset' }, [], TIMEOUT_LIVE_MS, null).catch(() => {});
  }
}

const workerClient = new ScannerWorkerClient();

export function disposeScannerResources(): void {
  if (activeController) {
    activeController.stop();
  }
  workerClient.dispose();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    disposeScannerResources();
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !activeController && workerClient.isIdle()) {
      workerClient.terminate('页面切至后台释放空闲 Worker', false);
    }
  });
}

function drawRegion(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  maxDim: number,
  minDim = 0,
): void {
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

async function decodeCanvasWithWorker(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  profile: string,
  signal?: AbortSignal | null,
): Promise<string> {
  throwIfAborted(signal);
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return '';
  const imgData = ctx.getImageData(0, 0, w, h);
  return workerClient.decodeRgba(w, h, imgData.data.buffer, profile, signal);
}

function loadImageElement(blobUrl: string, signal?: AbortSignal | null): Promise<HTMLImageElement> {
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

interface LoadedImageSource {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function loadCappedImageSource(
  file: Blob,
  signal?: AbortSignal | null,
): Promise<LoadedImageSource> {
  throwIfAborted(signal);
  const revokeUrl = URL.createObjectURL(file);
  let bitmap: ImageBitmap | null = null;
  let downscaleCanvas: HTMLCanvasElement | null = null;
  const closeBitmap = () => {
    const b = bitmap;
    bitmap = null;
    if (b && typeof b.close === 'function') b.close();
  };

  try {
    const img = await loadImageElement(revokeUrl, signal);
    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;
    if (!natW || !natH) throw new Error('图片尺寸无效');

    const longSide = Math.max(natW, natH);
    const needsResize = longSide > MAX_PHOTO_DIM;
    const targetW = needsResize ? Math.max(1, Math.round((natW * MAX_PHOTO_DIM) / longSide)) : natW;
    const targetH = needsResize ? Math.max(1, Math.round((natH * MAX_PHOTO_DIM) / longSide)) : natH;

    if (typeof globalThis.createImageBitmap === 'function') {
      try {
        bitmap = needsResize
          ? await globalThis.createImageBitmap(file, {
              resizeWidth: targetW,
              resizeHeight: targetH,
              resizeQuality: 'medium',
            })
          : await globalThis.createImageBitmap(file);
        throwIfAborted(signal);
        return {
          source: bitmap,
          width: bitmap.width || targetW,
          height: bitmap.height || targetH,
          release: () => {
            closeBitmap();
            URL.revokeObjectURL(revokeUrl);
          },
        };
      } catch (err: unknown) {
        if (err && (err as { name?: string }).name === 'AbortError') {
          closeBitmap();
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
      if (dctx) {
        dctx.imageSmoothingEnabled = true;
        dctx.imageSmoothingQuality = 'medium';
        dctx.drawImage(img, 0, 0, natW, natH, 0, 0, targetW, targetH);
      }
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
    closeBitmap();
    zeroCanvas(downscaleCanvas);
    URL.revokeObjectURL(revokeUrl);
    throw err;
  }
}

async function decodeSourceBudgeted(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  opts: { signal?: AbortSignal | null; onProgress?: (p: DecodeProgress) => void } = {},
): Promise<string> {
  const { signal, onProgress } = opts;
  throwIfAborted(signal);
  const detector = await getBarcodeDetector();
  throwIfAborted(signal);

  const deadline = performance.now() + PHOTO_BUDGET_MS;
  const total = detector ? 9 : 8;
  let step = 0;

  const report = (label: string) => {
    step++;
    if (typeof onProgress === 'function') {
      try {
        onProgress({ step, total, label });
      } catch {
        // ignore
      }
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
    } catch (err: unknown) {
      if (err && (err as { name?: string }).name === 'AbortError') throw err;
    }
    await yieldToMain(signal);
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';

  const stages = [
    {
      label: '正在解析高清原图…',
      sx: 0,
      sy: 0,
      sw: srcW,
      sh: srcH,
      maxDim: 1400,
      minDim: 0,
      profile: 'photo-fast',
    },
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

export async function decodeImageFile(
  file: Blob | File,
  opts: { signal?: AbortSignal | null; onProgress?: (p: DecodeProgress) => void } = {},
): Promise<string> {
  const { signal, onProgress } = opts;
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

function snapDigitalZoom(raw: number): number {
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

export interface CameraControllerOptions {
  video?: HTMLVideoElement;
  onResult: (text: string) => void;
  onStatus?: (text: string) => void;
  onError?: (err: string) => void;
  onZoomChange?: (info: ZoomInfo) => void;
  onTorchChange?: (info: TorchInfo) => void;
  onEngineChange?: (label: string) => void;
  onProgress?: (p: DecodeProgress) => void;
}

export interface CameraController {
  readonly state: string;
  start(videoEl?: HTMLVideoElement): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(): void;
  captureHighRes(): Promise<void>;
  setZoom(requested: number): void;
  toggleTorch(): Promise<boolean>;
  tapToFocus(nx?: number, ny?: number): void;
  getZoomInfo(): ZoomInfo;
  getTorchInfo(): TorchInfo;
}

export function createCameraController(options: CameraControllerOptions): CameraController {
  let video: HTMLVideoElement | null = options.video || null;
  let state: 'idle' | 'starting' | 'scanning' | 'capturing' | 'paused' | 'error' | 'closed' =
    'idle';
  const isClosed = () => state === 'closed';
  let sessionAbort = new AbortController();
  let captureAbort: AbortController | null = null;
  let startGen = 0;
  let scanGen = 0;

  let stream: MediaStream | null = null;
  let videoTrack: MediaStreamTrack | null = null;
  let trackCaps: ExtendedCapabilities = {};
  let imageCapture: ImageCaptureInstance | null = null;
  let detector: BarcodeDetectorInstance | null = null;
  let workerReady = false;

  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let vfcId = 0;
  let frameBusy = false;
  let frameIndex = 0;
  let enhancedToggle = false;
  let lastDecodeMs = 120;
  let intentionalTrackStop = false;

  let hasHwZoom = false;
  let hwZoomMin = 1;
  let hwZoomMax = 1;
  let hwZoomStep = 0.1;
  let targetZoom = 1;
  let currentHwZoom = 1;
  let currentDigitalZoom = 1;
  let lastAppliedHwZoom = 1;
  let zoomThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHwZoomAt = 0;
  let torchSupported = false;
  let torchOn = false;
  let engineLabel = 'WASM 高清';

  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;

  function emitStatus(text: string): void {
    options.onStatus?.(text);
  }

  function emitError(text: string): void {
    options.onError?.(text);
  }

  function getZoomInfo(): ZoomInfo {
    const effective = Math.round(currentHwZoom * currentDigitalZoom * 10) / 10;
    return {
      supported: true,
      min: hasHwZoom ? hwZoomMin : 1,
      max: Math.max(5, hwZoomMax),
      step: hasHwZoom ? hwZoomStep : 0.5,
      value: effective,
      digitalZoom: currentDigitalZoom,
      isDigital: !hasHwZoom || currentDigitalZoom > 1,
    };
  }

  function getTorchInfo(): TorchInfo {
    return {
      supported: torchSupported,
      active: torchOn,
    };
  }

  function emitZoom(): void {
    options.onZoomChange?.(getZoomInfo());
  }

  function emitTorch(): void {
    options.onTorchChange?.(getTorchInfo());
  }

  function cancelScanSchedule(): void {
    if (scanTimer !== null) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (vfcId && video && typeof video.cancelVideoFrameCallback === 'function') {
      try {
        video.cancelVideoFrameCallback(vfcId);
      } catch {
        // ignore
      }
      vfcId = 0;
    }
  }

  function clearAllTimers(): void {
    cancelScanSchedule();
    if (zoomThrottleTimer !== null) {
      clearTimeout(zoomThrottleTimer);
      zoomThrottleTimer = null;
    }
  }

  function flushHwZoom(): void {
    if (!videoTrack || !hasHwZoom || state === 'closed' || state === 'paused') return;
    if (Math.abs(currentHwZoom - lastAppliedHwZoom) < 0.01) return;
    lastAppliedHwZoom = currentHwZoom;
    lastHwZoomAt = performance.now();
    videoTrack
      .applyConstraints({ advanced: [{ zoom: currentHwZoom } as MediaTrackConstraintSet] })
      .catch(() => {});
  }

  function setZoom(requested: number): void {
    const maxTotal = Math.max(5, hwZoomMax);
    targetZoom = Math.min(maxTotal, Math.max(1, requested));
    currentHwZoom = hasHwZoom ? Math.min(hwZoomMax, Math.max(hwZoomMin, targetZoom)) : 1;
    currentDigitalZoom = snapDigitalZoom(targetZoom / currentHwZoom);

    if (hasHwZoom && videoTrack) {
      const elapsed = performance.now() - lastHwZoomAt;
      if (elapsed >= 60) {
        if (zoomThrottleTimer !== null) {
          clearTimeout(zoomThrottleTimer);
          zoomThrottleTimer = null;
        }
        flushHwZoom();
      } else if (zoomThrottleTimer === null) {
        zoomThrottleTimer = setTimeout(() => {
          zoomThrottleTimer = null;
          flushHwZoom();
        }, 60 - elapsed);
      }
    }
    emitZoom();
  }

  async function toggleTorch(): Promise<boolean> {
    if (!videoTrack || !torchSupported || state === 'closed') return torchOn;
    const next = !torchOn;
    try {
      await videoTrack.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      torchOn = next;
      emitTorch();
    } catch {
      // ignore unsupported torch toggle
    }
    return torchOn;
  }

  function tapToFocus(_nx?: number, _ny?: number): void {
    if (
      videoTrack &&
      Array.isArray(trackCaps.focusMode) &&
      trackCaps.focusMode.includes('continuous')
    ) {
      videoTrack
        .applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
        .catch(() => {});
    }
  }

  function onTrackEnded(): void {
    if (intentionalTrackStop || state === 'closed' || state === 'paused') return;
    cancelScanSchedule();
    scanGen++;
    state = 'paused';
    emitStatus('摄像头连接已中断，可点击重新开启或改用相册。');
    zeroCanvas(canvas);
  }

  function stopTracks(): void {
    intentionalTrackStop = true;
    if (videoTrack) {
      videoTrack.removeEventListener('ended', onTrackEnded);
      if (torchOn) {
        try {
          videoTrack
            .applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] })
            .catch(() => {});
        } catch {
          // ignore
        }
        torchOn = false;
        emitTorch();
      }
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      stream = null;
    }
    videoTrack = null;
    trackCaps = {};
    imageCapture = null;
    if (video) {
      video.srcObject = null;
    }
    zeroCanvas(canvas);
    intentionalTrackStop = false;
  }

  function finishWithResult(text: string): void {
    if (!text || state === 'closed') return;
    stop();
    options.onResult(text);
  }

  function scheduleNextScan(delayMs: number): void {
    if (state !== 'scanning') return;
    cancelScanSchedule();
    const myGen = scanGen;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (state !== 'scanning' || myGen !== scanGen) return;
      if (video && typeof video.requestVideoFrameCallback === 'function') {
        vfcId = video.requestVideoFrameCallback(() => {
          vfcId = 0;
          if (state === 'scanning' && myGen === scanGen) void runLiveFrame(myGen);
        });
      } else {
        void runLiveFrame(myGen);
      }
    }, delayMs);
  }

  async function runLiveFrame(myGen: number): Promise<void> {
    if (state !== 'scanning' || myGen !== scanGen || !video) return;
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
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length > 0 && codes[0].rawValue) {
            text = codes[0].rawValue.trim();
          }
        } catch {
          // ignore
        }
      } else if (workerReady && canvas && ctx) {
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
    } catch (err: unknown) {
      if (err && (err as { name?: string }).name === 'AbortError') return;
    } finally {
      frameBusy = false;
      lastDecodeMs = Math.max(1, performance.now() - t0);
    }

    if (state === 'scanning' && myGen === scanGen) {
      const nextDelay = Math.max(120, Math.min(400, Math.round(lastDecodeMs * 1.5)));
      scheduleNextScan(nextDelay);
    }
  }

  async function captureHighRes(): Promise<void> {
    if (state !== 'scanning' || !video) return;
    state = 'capturing';
    cancelScanSchedule();
    scanGen++;

    captureAbort = new AbortController();
    const sig = captureAbort.signal;
    emitStatus('正在拍摄高清原帧…');

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
              if (state === 'capturing') {
                emitStatus(p.label);
                options.onProgress?.(p);
              }
            },
          }).catch((err: unknown) => {
            if (err && (err as { name?: string }).name === 'AbortError') throw err;
            return '';
          });
        } catch (err: unknown) {
          if (err && (err as { name?: string }).name === 'AbortError') return;
          takePhotoFailed = true;
        }
      } else {
        takePhotoFailed = true;
      }

      if (
        takePhotoFailed &&
        !text &&
        state === 'capturing' &&
        video.readyState >= 2 &&
        video.videoWidth &&
        video.videoHeight
      ) {
        emitStatus('正在精扫当前高清帧…');
        text = await decodeSourceBudgeted(video, video.videoWidth, video.videoHeight, {
          signal: sig,
          onProgress: (p) => {
            if (state === 'capturing') {
              emitStatus(p.label);
              options.onProgress?.(p);
            }
          },
        }).catch((err: unknown) => {
          if (err && (err as { name?: string }).name === 'AbortError') throw err;
          return '';
        });
      }

      if (text && state === 'capturing') {
        finishWithResult(text);
        return;
      }

      if (state === 'capturing') {
        emitStatus('未识别到二维码，可拉近倍率或轻点屏幕对焦后重试');
      }
    } catch (err: unknown) {
      if (err && (err as { name?: string }).name === 'AbortError') return;
      if (state === 'capturing') {
        emitStatus('高清拍帧失败，请继续对准或使用相册识码');
      }
    } finally {
      captureAbort = null;
      if (state === 'capturing') {
        state = 'scanning';
        scheduleNextScan(150);
      }
    }
  }

  async function requestCameraStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 },
          focusMode: { ideal: 'continuous' },
        } as MediaTrackConstraints,
        audio: false,
      });
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotFoundError') {
        throw err;
      }
      return navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    }
  }

  function onVisibilityChange(): void {
    if (state === 'closed' || state === 'idle') return;
    if (document.visibilityState === 'hidden') {
      pause();
    } else if (document.visibilityState === 'visible' && state === 'paused') {
      void resume();
    }
  }

  async function startCamera(): Promise<void> {
    const myStartGen = ++startGen;
    state = 'starting';

    const support = getScannerSupport();
    if (!support.camera) {
      state = 'error';
      emitError('当前环境不支持网页摄像头（需 HTTPS），请改用相册识码。');
      return;
    }

    if (!support.barcodeDetector && !support.wasmWorker) {
      state = 'error';
      emitError('当前浏览器不支持二维码解码，请改用现代浏览器或系统相机。');
      return;
    }

    emitStatus('正在请求高清后置摄像头…');

    let mediaStream: MediaStream | null = null;
    try {
      const [wOk, det, acquired] = await Promise.all([
        workerClient.ensureReady(sessionAbort.signal).catch(() => false),
        getBarcodeDetector(),
        requestCameraStream(),
      ]);
      mediaStream = acquired;

      if (isClosed() || sessionAbort.signal.aborted || myStartGen !== startGen) {
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
        state = 'error';
        emitError('解码引擎初始化失败，请刷新重试或改用相册识码。');
        stopTracks();
        return;
      }
      options.onEngineChange?.(engineLabel);

      if (video) {
        video.srcObject = stream;
        await video.play();
      }

      if (isClosed() || sessionAbort.signal.aborted || myStartGen !== startGen) {
        stopTracks();
        return;
      }

      videoTrack = stream.getVideoTracks()[0] || null;
      hasHwZoom = false;
      hwZoomMin = 1;
      hwZoomMax = 1;
      hwZoomStep = 0.1;
      torchSupported = false;
      torchOn = false;

      if (videoTrack) {
        videoTrack.addEventListener('ended', onTrackEnded);
        if (typeof videoTrack.getCapabilities === 'function') {
          try {
            trackCaps = (videoTrack.getCapabilities() as ExtendedCapabilities) || {};
          } catch {
            trackCaps = {};
          }
        }
        if (trackCaps.zoom && typeof trackCaps.zoom.max === 'number' && trackCaps.zoom.max > 1) {
          hasHwZoom = true;
          hwZoomMin = typeof trackCaps.zoom.min === 'number' ? Math.max(1, trackCaps.zoom.min) : 1;
          hwZoomMax = trackCaps.zoom.max;
          hwZoomStep =
            typeof trackCaps.zoom.step === 'number' && trackCaps.zoom.step > 0
              ? trackCaps.zoom.step
              : 0.1;
        }
        if (Array.isArray(trackCaps.focusMode) && trackCaps.focusMode.includes('continuous')) {
          videoTrack
            .applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
            .catch(() => {});
        }
        if (trackCaps.torch === true) {
          torchSupported = true;
        }
        const ImageCaptureAPI = (globalThis as unknown as { ImageCapture?: ImageCaptureCtor })
          .ImageCapture;
        if (typeof ImageCaptureAPI === 'function') {
          try {
            imageCapture = new ImageCaptureAPI(videoTrack);
          } catch {
            imageCapture = null;
          }
        }
      }

      emitTorch();
      setZoom(targetZoom);
      state = 'scanning';
      emitStatus('对准教室大屏二维码，支持双指缩放与点击对焦');
      scheduleNextScan(120);
    } catch (err: unknown) {
      if (mediaStream) {
        for (const t of mediaStream.getTracks()) t.stop();
      }
      if (
        isClosed() ||
        (err && (err as { name?: string }).name === 'AbortError') ||
        myStartGen !== startGen
      ) {
        return;
      }
      state = 'error';
      const e = err as { name?: string; message?: string } | null;
      const msg =
        e && e.name === 'NotAllowedError'
          ? '未授予摄像头权限，请在浏览器设置中允许或使用相册识码。'
          : `无法打开摄像头（${(e && e.message) || '权限受限'}），可改用相册识码。`;
      emitError(msg);
    }
  }

  async function start(videoEl?: HTMLVideoElement): Promise<void> {
    if (videoEl) {
      video = videoEl;
    }
    if (activeController && activeController !== controller) {
      activeController.stop();
    }
    activeController = controller;
    workerClient.resetRestarts();
    if (sessionAbort.signal.aborted) {
      sessionAbort = new AbortController();
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    await startCamera();
  }

  function pause(): void {
    if (state === 'closed' || state === 'paused' || state === 'idle') return;
    state = 'paused';
    startGen++;
    scanGen++;
    if (captureAbort) {
      captureAbort.abort();
      captureAbort = null;
    }
    clearAllTimers();
    stopTracks();
    emitStatus('已暂停');
  }

  async function resume(): Promise<void> {
    if (state === 'closed' || state === 'scanning' || state === 'starting') return;
    if (sessionAbort.signal.aborted) {
      sessionAbort = new AbortController();
    }
    await startCamera();
  }

  function stop(): void {
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
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (activeController === controller) {
      activeController = null;
    }
    workerClient.sendReset();
    workerClient.scheduleIdleTerminate();
  }

  const controller: CameraController = {
    get state() {
      return state;
    },
    start,
    pause,
    resume,
    stop,
    captureHighRes,
    setZoom,
    toggleTorch,
    tapToFocus,
    getZoomInfo,
    getTorchInfo,
  };

  return controller;
}
