import { useEffect, useRef, useState } from 'preact/hooks';
import type { TorchInfo, ZoomInfo } from '../types/protocol';
import { createCameraController, type CameraController } from '../lib/scanner';
import { Icon } from './TopBar';
import { ToastHost, useDialogToastLayer } from './ToastHost';

const ZOOM_PRESETS = [1, 2, 3, 5] as const;

const DEFAULT_ZOOM: ZoomInfo = {
  supported: false,
  min: 1,
  max: 5,
  step: 0.1,
  value: 1,
  digitalZoom: 1,
  isDigital: true,
};

const DEFAULT_TORCH: TorchInfo = {
  supported: false,
  active: false,
};

function formatZoomLabel(z: number): string {
  const rounded = Math.round(z * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}x`;
}

function touchDistance(t1: Touch, t2: Touch): number {
  return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
}

export interface CameraScannerModalProps {
  open: boolean;
  onResult: (text: string) => void;
  onPickFile: () => void;
  onClose: () => void;
}

export function CameraScannerModal({
  open,
  onResult,
  onPickFile,
  onClose,
}: CameraScannerModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<CameraController | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const pinchStartDistRef = useRef(0);
  const pinchStartZoomRef = useRef(1);
  const isPinchingRef = useRef(false);
  const pinchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [statusText, setStatusText] = useState('正在请求高清后置摄像头…');
  const [engineLabel, setEngineLabel] = useState('准备引擎…');
  const [zoomInfo, setZoomInfo] = useState<ZoomInfo>(DEFAULT_ZOOM);
  const [torchInfo, setTorchInfo] = useState<TorchInfo>(DEFAULT_TORCH);
  const [hasError, setHasError] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [reticle, setReticle] = useState<{ x: number; y: number; active: boolean }>({
    x: 50,
    y: 50,
    active: false,
  });

  useDialogToastLayer('camera-scanner-modal', open);

  const restoreFocus = () => {
    const prev = prevFocusRef.current;
    prevFocusRef.current = null;
    if (prev && prev.isConnected) {
      try {
        prev.focus({ preventScroll: true });
      } catch {
        // ignore focus errors
      }
    }
  };

  const stopController = () => {
    if (ctrlRef.current) {
      try {
        ctrlRef.current.stop();
      } catch {
        // ignore stop errors
      }
      ctrlRef.current = null;
    }
    if (focusTimerRef.current) {
      clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    }
    if (pinchTimerRef.current) {
      clearTimeout(pinchTimerRef.current);
      pinchTimerRef.current = null;
    }
  };

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;

    if (!open) {
      stopController();
      if (dlg.open) {
        dlg.close();
      }
      restoreFocus();
      return;
    }

    prevFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setStatusText('正在请求高清后置摄像头…');
    setEngineLabel('准备引擎…');
    setZoomInfo(DEFAULT_ZOOM);
    setTorchInfo(DEFAULT_TORCH);
    setHasError(false);
    setCapturing(false);
    setReticle({ x: 50, y: 50, active: false });

    if (!dlg.open) {
      dlg.showModal();
    }

    const videoEl = videoRef.current ?? undefined;
    const ctrl = createCameraController({
      video: videoEl,
      onResult: (text: string) => {
        stopController();
        onResultRef.current(text);
      },
      onStatus: (text: string) => {
        setStatusText(text);
      },
      onError: (err: string) => {
        setHasError(true);
        setStatusText(err);
      },
      onZoomChange: (info: ZoomInfo) => {
        setZoomInfo(info);
      },
      onTorchChange: (info: TorchInfo) => {
        setTorchInfo(info);
      },
      onEngineChange: (label: string) => {
        setEngineLabel(label);
      },
    });
    ctrlRef.current = ctrl;

    void ctrl.start(videoEl).catch((err: unknown) => {
      setHasError(true);
      setStatusText(
        err instanceof Error && err.message
          ? err.message
          : '无法开启摄像头，请检查权限或使用相册识码',
      );
    });

    const onVisibility = () => {
      if (!ctrlRef.current) return;
      if (document.visibilityState === 'hidden') {
        ctrlRef.current.pause();
      } else if (document.visibilityState === 'visible') {
        setHasError(false);
        void ctrlRef.current.resume();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopController();
    };
  }, [open]);

  const handleClose = () => {
    stopController();
    onCloseRef.current();
  };

  const handleStageClick = (e: MouseEvent) => {
    if (isPinchingRef.current) return;
    if (e.target instanceof Element && e.target.closest('button, input')) return;
    const stage = stageRef.current;
    if (!stage || !ctrlRef.current) return;

    const rect = stage.getBoundingClientRect();
    const nx = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0.5;
    const ny = rect.height > 0 ? Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) : 0.5;

    setReticle({ x: nx * 100, y: ny * 100, active: true });
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = null;
      setReticle((r) => ({ ...r, active: false }));
    }, 460);

    ctrlRef.current.tapToFocus(nx, ny);
  };

  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      isPinchingRef.current = true;
      pinchStartDistRef.current = touchDistance(e.touches[0], e.touches[1]);
      pinchStartZoomRef.current = zoomInfo.value;
    }
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && pinchStartDistRef.current > 0 && ctrlRef.current) {
      e.preventDefault();
      const dist = touchDistance(e.touches[0], e.touches[1]);
      if (dist > 0) {
        ctrlRef.current.setZoom(pinchStartZoomRef.current * (dist / pinchStartDistRef.current));
      }
    }
  };

  const handleTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) {
      pinchStartDistRef.current = 0;
      if (pinchTimerRef.current) clearTimeout(pinchTimerRef.current);
      pinchTimerRef.current = setTimeout(() => {
        pinchTimerRef.current = null;
        isPinchingRef.current = false;
      }, 120);
    }
  };

  const handleCapture = async () => {
    if (!ctrlRef.current || capturing) return;
    setCapturing(true);
    try {
      await ctrlRef.current.captureHighRes();
    } finally {
      setCapturing(false);
    }
  };

  const handleRetry = () => {
    if (!ctrlRef.current) return;
    setHasError(false);
    setStatusText('正在重新开启摄像头…');
    void ctrlRef.current.resume().catch((err: unknown) => {
      setHasError(true);
      setStatusText(
        err instanceof Error && err.message ? err.message : '重新开启相机失败',
      );
    });
  };

  const maxZoom = Math.max(5, zoomInfo.max || 5);
  const minZoom = Math.max(1, zoomInfo.min || 1);
  const currentZoom = Math.min(maxZoom, Math.max(minZoom, zoomInfo.value || 1));

  let closestPreset: number = ZOOM_PRESETS[0];
  let minDiff = Math.abs(currentZoom - closestPreset);
  for (let i = 1; i < ZOOM_PRESETS.length; i++) {
    const d = Math.abs(currentZoom - ZOOM_PRESETS[i]);
    if (d < minDiff) {
      minDiff = d;
      closestPreset = ZOOM_PRESETS[i];
    }
  }

  return (
    <dialog
      ref={dialogRef}
      class="sheet"
      aria-label="网页相机扫码"
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          handleClose();
        }
      }}
    >
      <div class="sheet-body">
        <div class="scanner-sheet">
          <div class="sheet-head">
            <h2>网页相机扫码</h2>
            <button
              type="button"
              class="icon-btn"
              aria-label="关闭"
              onClick={handleClose}
            >
              <Icon name="x" size={20} />
            </button>
          </div>

          <div
            ref={stageRef}
            class="scanner-stage"
            onClick={handleStageClick}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
          >
            <video
              ref={videoRef}
              class="scanner-video"
              playsInline
              muted
              autoPlay
              style={{
                transform:
                  zoomInfo.digitalZoom > 1 ? `scale(${zoomInfo.digitalZoom})` : 'scale(1)',
              }}
            />

            <div class="scanner-frame" aria-hidden="true" />
            <div
              class={reticle.active ? 'scanner-focus-reticle active' : 'scanner-focus-reticle'}
              style={{ left: `${reticle.x}%`, top: `${reticle.y}%` }}
              aria-hidden="true"
            />

            <div class="scanner-overlay-top">
              <span class="scanner-pill">
                {engineLabel} · {formatZoomLabel(currentZoom)}
              </span>

              {torchInfo.supported ? (
                <button
                  type="button"
                  class="scanner-tool-btn"
                  aria-label="手电筒"
                  aria-pressed={torchInfo.active}
                  onClick={(e) => {
                    e.stopPropagation();
                    void ctrlRef.current?.toggleTorch();
                  }}
                >
                  <Icon name="flash" size={18} />
                </button>
              ) : null}
            </div>

            <div class="scanner-controls-bottom">
              <div
                class="scanner-zoom-slider-wrap"
                onClick={(e) => e.stopPropagation()}
              >
                <span>{formatZoomLabel(minZoom)}</span>
                <input
                  type="range"
                  class="scanner-zoom-slider"
                  aria-label="调节变焦倍率"
                  min={minZoom}
                  max={maxZoom}
                  step={zoomInfo.step > 0 ? zoomInfo.step : 0.1}
                  value={currentZoom}
                  onInput={(e) => {
                    const val = Number((e.currentTarget as HTMLInputElement).value);
                    ctrlRef.current?.setZoom(val);
                  }}
                />
                <span>{formatZoomLabel(maxZoom)}</span>
              </div>

              <div class="scanner-zoom-bar" role="group" aria-label="快捷变焦倍率">
                {ZOOM_PRESETS.map((z) => (
                  <button
                    key={z}
                    type="button"
                    class="scanner-zoom-btn"
                    aria-pressed={z === closestPreset}
                    onClick={(e) => {
                      e.stopPropagation();
                      ctrlRef.current?.setZoom(z);
                    }}
                  >
                    {z}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div class="scanner-foot">
            <p class="scanner-status" role="status" aria-live="polite">
              {statusText}
            </p>
            <div class="scanner-actions">
              {hasError ? (
                <button
                  type="button"
                  class="btn primary"
                  onClick={handleRetry}
                >
                  <Icon name="refresh" size={18} />
                  <span>重新开启相机</span>
                </button>
              ) : (
                <button
                  type="button"
                  class="btn primary"
                  disabled={capturing}
                  onClick={() => void handleCapture()}
                >
                  <Icon name="camera" size={18} />
                  <span>{capturing ? '正在识码…' : '高清拍一帧'}</span>
                </button>
              )}

              <button
                type="button"
                class="btn tonal"
                onClick={() => {
                  stopController();
                  onPickFile();
                }}
              >
                <Icon name="image" size={18} />
                <span>相册</span>
              </button>

              <button
                type="button"
                class="btn ghost"
                onClick={handleClose}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      </div>

      {open ? <ToastHost layerId="camera-scanner-modal" /> : null}
    </dialog>
  );
}
