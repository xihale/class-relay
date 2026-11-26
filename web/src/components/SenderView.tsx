import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  DecodeProgress,
  RelayItem,
  RoomPeers,
  RoomReceipts,
} from '../types/protocol';
import {
  decodeImageFile,
  extractUrl,
  getScannerSupport,
} from '../lib/scanner';
import {
  guessSource,
  remainSeconds,
} from '../lib/storage';
import { Icon } from './TopBar';
import { showToast } from './ToastHost';

const SOURCES = ['微助教', '雨课堂', '普通链接'] as const;
const TTLS = [60, 90, 180] as const;

export interface SenderViewProps {
  room: string;
  activeItem: RelayItem | null;
  nowMs: number;
  peers: RoomPeers;
  receipts: RoomReceipts;
  url: string;
  source: string;
  ttl: number;
  busy: boolean;
  error: string;
  onUrlChange: (val: string) => void;
  onSourceChange: (val: string) => void;
  onTtlChange: (val: number) => void;
  onErrorChange: (val: string) => void;
  onPush: (url: string, source: string, ttlSec: number) => Promise<boolean>;
  onClear: () => Promise<void>;
  onOpenCamera: () => void;
  fileInputRef: { current: HTMLInputElement | null };
}

export function SenderView({
  activeItem,
  nowMs,
  peers,
  receipts,
  url,
  source,
  ttl,
  busy,
  error,
  onUrlChange,
  onSourceChange,
  onTtlChange,
  onErrorChange,
  onPush,
  onClear,
  onOpenCamera,
  fileInputRef,
}: SenderViewProps) {
  const [decodeProgress, setDecodeProgress] = useState<DecodeProgress | null>(null);
  const [manualOpen, setManualOpen] = useState(() => Boolean(url.trim() || error));
  const decodeAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (error || url.trim()) {
      setManualOpen(true);
    }
  }, [error, url]);

  const cameraReady = useMemo(() => {
    try {
      return getScannerSupport().camera;
    } catch {
      return false;
    }
  }, []);

  const isDecoding = decodeProgress !== null;
  const isBusy = busy || isDecoding;

  const handleScannedText = async (rawText: string) => {
    const text = String(rawText || '').trim();
    const extracted = extractUrl(text);
    if (!extracted) {
      onUrlChange(text);
      onErrorChange('二维码内容不包含 http(s):// 链接，已填入下方供核对');
      setManualOpen(true);
      showToast('未识别到网址，请检查二维码内容');
      return;
    }
    onUrlChange(extracted);
    onErrorChange('');
    const detected = guessSource(extracted, source);
    if (detected !== source) {
      onSourceChange(detected);
    }
    await onPush(extracted, detected, ttl);
  };

  const handleImageFile = async (file: File | undefined) => {
    if (!file) return;
    if (decodeAbortRef.current) {
      decodeAbortRef.current.abort();
    }
    const ac = new AbortController();
    decodeAbortRef.current = ac;
    onErrorChange('');
    setDecodeProgress({ step: 0, total: 1, label: '正在读取图片…' });

    try {
      const text = await decodeImageFile(file, {
        signal: ac.signal,
        onProgress: (p: DecodeProgress) => {
          if (!ac.signal.aborted) {
            setDecodeProgress(p);
          }
        },
      });
      if (ac.signal.aborted) return;
      decodeAbortRef.current = null;
      setDecodeProgress(null);
      await handleScannedText(text);
    } catch (err) {
      if (decodeAbortRef.current === ac) {
        decodeAbortRef.current = null;
      }
      setDecodeProgress(null);
      if (err instanceof Error && err.name === 'AbortError') {
        showToast('已取消图片识码');
        return;
      }
      const msg = err instanceof Error && err.message ? err.message : '图片识码失败';
      onErrorChange(msg);
      showToast(msg);
    }
  };

  const handleCancelDecode = () => {
    if (decodeAbortRef.current) {
      decodeAbortRef.current.abort();
      decodeAbortRef.current = null;
    }
    setDecodeProgress(null);
  };

  const handlePasteOrExtract = async () => {
    const existing = extractUrl(url);
    if (existing && existing !== url.trim()) {
      onUrlChange(existing);
      onErrorChange('');
      showToast('已从文本中提取链接');
      return;
    }
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try {
        const clip = (await navigator.clipboard.readText()).trim();
        if (clip) {
          const extracted = extractUrl(clip);
          onUrlChange(extracted || clip);
          onErrorChange(extracted ? '' : '剪贴板内容未检测到 http(s):// 链接');
          showToast(extracted ? '已粘贴并提取链接' : '已粘贴剪贴板内容');
          return;
        }
      } catch {
        // clipboard permission denied
      }
    }
    showToast('请长按输入框手动粘贴链接');
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const extracted = extractUrl(url);
    if (!extracted) {
      onErrorChange('请输入包含 http:// 或 https:// 的签到链接');
      return;
    }
    onErrorChange('');
    await onPush(extracted, source, ttl);
  };

  const remain = activeItem ? remainSeconds(activeItem.expiresAtLocal, nowMs) : 0;
  const pct = decodeProgress && decodeProgress.total > 0
    ? Math.min(100, Math.max(8, Math.round((decodeProgress.step / decodeProgress.total) * 100)))
    : 15;

  return (
    <section class="card relay-card" aria-label="教室发码扫码端">
      <div class="sender-quiet-meta" aria-live="polite">
        <span class="sender-quiet-peers">
          <span
            class={peers.recv > 0 ? 'relay-dot live' : 'relay-dot'}
            aria-hidden="true"
          />
          <span>
            {peers.recv > 0
              ? `${peers.recv} 位同学等待收码`
              : '暂无同学等待，可先分享房间链接'}
          </span>
        </span>
      </div>

      {!cameraReady ? (
        <div class="sender-cap-warn">
          当前环境不支持实时相机（需 HTTPS），可使用「相册 / 截图识码」。
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const input = e.currentTarget as HTMLInputElement;
          const file = input.files?.[0];
          input.value = '';
          void handleImageFile(file);
        }}
      />

      <div class="sender-scan-actions">
        <button
          type="button"
          class="btn primary hero"
          disabled={isBusy}
          onClick={onOpenCamera}
        >
          <Icon name="scan" size={20} />
          <span>扫一扫发码</span>
        </button>

        <button
          type="button"
          class="btn tonal wide-btn"
          disabled={isBusy}
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="image" size={17} />
          <span>{isDecoding ? decodeProgress.label : '相册 / 截图识码'}</span>
        </button>
      </div>

      {isDecoding ? (
        <div class="decode-progress-card" role="status" aria-live="polite">
          <div class="decode-progress-head">
            <span>{decodeProgress.label}</span>
            <button
              type="button"
              class="btn small danger-ghost"
              onClick={handleCancelDecode}
            >
              取消
            </button>
          </div>
          <div class="decode-progress-track">
            <div class="decode-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}

      {activeItem ? (
        <div class="sender-preview-card">
          <div class="relay-active-head">
            <div class="relay-badges">
              <span class="relay-pill">{activeItem.source}</span>
              <span
                id="relay-ttl"
                class={remain <= 15 ? 'relay-pill ttl urgent' : 'relay-pill ttl'}
              >
                {remain}s
              </span>
              <span class="sender-receipts" aria-live="polite">
                已送达 {receipts.delivered} · 已跳转 {receipts.jumped}
              </span>
            </div>
            <button
              type="button"
              class="btn text"
              onClick={() => void onClear()}
            >
              撤回
            </button>
          </div>
          <div class="stack-sm">
            <b>{activeItem.host || '当前房间有效链接'}</b>
            <p class="relay-url" title={activeItem.url}>{activeItem.url}</p>
          </div>
        </div>
      ) : null}

      <div class={manualOpen ? 'disclosure-wrap expanded' : 'disclosure-wrap'}>
        <button
          type="button"
          class="disclosure-toggle"
          aria-expanded={manualOpen}
          aria-controls="sender-manual-panel"
          onClick={() => setManualOpen((v) => !v)}
        >
          <span>手动粘贴链接 · {source} · {ttl}s</span>
          <Icon name="down" size={16} class="disclosure-toggle-icon" />
        </button>

        <form
          id="sender-manual-panel"
          class="sender-form"
          hidden={!manualOpen}
          onSubmit={handleSubmit}
        >
          <div class="field">
            <div class="field-head">
              <label class="field-label" for="sender-url-input">
                签到链接
              </label>
              <button
                type="button"
                class="btn text"
                onClick={() => void handlePasteOrExtract()}
              >
                粘贴 / 提取
              </button>
            </div>
            <textarea
              id="sender-url-input"
              class="input relay-tonal-input"
              value={url}
              placeholder="粘贴包含 http(s):// 的签到链接或文本"
              aria-describedby={error ? 'sender-url-error' : undefined}
              onInput={(e) => {
                onUrlChange((e.currentTarget as HTMLTextAreaElement).value);
                if (error) onErrorChange('');
              }}
            />
          </div>

          <div class="sender-form-grid">
            <div class="field">
              <span class="field-label">平台</span>
              <div class="seg" role="group" aria-label="来源平台">
                {SOURCES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    class="seg-btn"
                    aria-pressed={source === s}
                    onClick={() => onSourceChange(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div class="field">
              <span class="field-label">时长</span>
              <div class="seg" role="group" aria-label="有效时长">
                {TTLS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    class="seg-btn"
                    aria-pressed={ttl === t}
                    onClick={() => onTtlChange(t)}
                  >
                    {t}s
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error ? (
            <p id="sender-url-error" class="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <div class="sender-form-actions">
            <button type="submit" class="btn primary" disabled={isBusy}>
              <Icon name="send" size={16} />
              <span>{busy ? '发送中…' : '推送到房间'}</span>
            </button>
            {activeItem ? (
              <button
                type="button"
                class="btn danger-ghost"
                disabled={isBusy}
                onClick={() => void onClear()}
              >
                清除
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}
