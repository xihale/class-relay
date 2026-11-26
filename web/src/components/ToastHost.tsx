import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

const MAX_TOASTS = 2;

export interface ToastItem {
  id: number;
  message: string;
  action?: string;
  onAction?: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const toasts = signal<ToastItem[]>([]);
const layerStack = signal<string[]>(['root']);
let nextToastId = 1;

function removeToast(id: number): void {
  const cur = toasts.value;
  const found = cur.find((t) => t.id === id);
  if (found?.timer) {
    clearTimeout(found.timer);
  }
  toasts.value = cur.filter((t) => t.id !== id);
}

export function showToast(
  message: string,
  opts?: { action?: string; onAction?: () => void; ms?: number },
): () => void {
  const text = String(message || '').trim();
  if (!text) return () => {};
  const action = opts?.action || '';
  const ms = opts?.ms ?? 4000;

  const existing = toasts.value.find((t) => t.message === text && (t.action || '') === action);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => removeToast(existing.id), ms);
    return () => removeToast(existing.id);
  }

  const nextList = [...toasts.value];
  while (nextList.length >= MAX_TOASTS) {
    const oldest = nextList.shift();
    if (oldest?.timer) clearTimeout(oldest.timer);
  }

  const id = nextToastId++;
  const item: ToastItem = {
    id,
    message: text,
    action: action || undefined,
    onAction: opts?.onAction,
    timer: setTimeout(() => removeToast(id), ms),
  };
  nextList.push(item);
  toasts.value = nextList;

  return () => removeToast(id);
}

export function useDialogToastLayer(layerId: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    layerStack.value = [...layerStack.value.filter((l) => l !== layerId), layerId];
    return () => {
      layerStack.value = layerStack.value.filter((l) => l !== layerId);
    };
  }, [layerId, active]);
}

export interface ToastHostProps {
  layerId?: string;
}

export function ToastHost({ layerId = 'root' }: ToastHostProps) {
  const stack = layerStack.value;
  const activeLayer = stack[stack.length - 1] || 'root';
  const isOwner = activeLayer === layerId;
  const items = isOwner ? toasts.value : [];

  return (
    <div
      class="toasts"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {items.map((item) => (
        <div class="toast" key={item.id}>
          <span>{item.message}</span>
          {item.action ? (
            <button
              type="button"
              class="toast-action"
              onClick={() => {
                removeToast(item.id);
                item.onAction?.();
              }}
            >
              {item.action}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
