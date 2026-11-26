import { useEffect, useRef, useState } from 'preact/hooks';
import type { Preset } from '../types/protocol';
import { Icon } from './TopBar';
import { ToastHost, useDialogToastLayer } from './ToastHost';

export interface PresetEditModalProps {
  preset: Preset | null;
  onClose: () => void;
  onSave: (presetId: string, url: string) => void;
}

export function PresetEditModal({ preset, onClose, onSave }: PresetEditModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const isOpen = preset !== null;
  useDialogToastLayer('preset-edit-modal', isOpen);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;

    if (preset) {
      prevFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setUrl(preset.url);
      setError('');
      if (!dlg.open) {
        dlg.showModal();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  }, [preset]);

  const restoreFocusAndClose = () => {
    const prev = prevFocusRef.current;
    prevFocusRef.current = null;
    onClose();
    if (prev && prev.isConnected) {
      try {
        prev.focus({ preventScroll: true });
      } catch {
        // ignore focus errors
      }
    }
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!preset) return;
    const val = url.trim();
    if (val && !/^https?:\/\/\S+/i.test(val)) {
      setError('请输入以 http:// 或 https:// 开头的有效地址');
      return;
    }
    onSave(preset.id, val);
    restoreFocusAndClose();
  };

  return (
    <dialog
      ref={dialogRef}
      class="sheet"
      aria-label={preset ? `配置 ${preset.name}` : '配置预热入口'}
      onCancel={(e) => {
        e.preventDefault();
        restoreFocusAndClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          restoreFocusAndClose();
        }
      }}
    >
      <div class="sheet-body">
        {preset ? (
          <form class="form" onSubmit={handleSubmit}>
            <div class="sheet-head">
              <h2>配置 {preset.name}</h2>
              <button
                type="button"
                class="icon-btn"
                aria-label="关闭"
                onClick={restoreFocusAndClose}
              >
                <Icon name="x" size={20} />
              </button>
            </div>

            <div class="relay-sheet-fields">
              <div class="field">
                <label class="field-label" for="preset-url-input">
                  预热入口地址
                </label>
                <input
                  id="preset-url-input"
                  type="url"
                  class="input relay-tonal-input"
                  value={url}
                  placeholder="https://..."
                  aria-describedby={error ? 'preset-url-error' : undefined}
                  onInput={(e) => {
                    setUrl((e.currentTarget as HTMLInputElement).value);
                    if (error) setError('');
                  }}
                />
                <p class="hint">{preset.hint}</p>
              </div>

              {error ? (
                <p id="preset-url-error" class="form-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            <div class="sheet-foot">
              <button
                type="button"
                class="btn ghost"
                onClick={restoreFocusAndClose}
              >
                取消
              </button>
              <button type="submit" class="btn primary">
                保存
              </button>
            </div>
          </form>
        ) : null}
      </div>
      {isOpen ? <ToastHost layerId="preset-edit-modal" /> : null}
    </dialog>
  );
}
