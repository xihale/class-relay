import { useMemo } from 'preact/hooks';
import type { RelayItem, RoomPeers } from '../types/protocol';
import type { RedirectController } from '../lib/redirect';
import { renderQRDataURL } from '../lib/qr';
import { copyText, remainSeconds } from '../lib/storage';
import { Icon } from './TopBar';
import { showToast } from './ToastHost';

export interface ReceiverViewProps {
  item: RelayItem | null;
  nowMs: number;
  peers: RoomPeers;
  autoRedirect: boolean;
  redirect: RedirectController;
  onToggleAutoRedirect: () => void;
  onClear: () => void;
  onSwitchToSend: (url: string, source: string) => void;
}

export function ReceiverView({
  item,
  nowMs,
  peers,
  autoRedirect,
  redirect,
  onToggleAutoRedirect,
  onClear,
  onSwitchToSend,
}: ReceiverViewProps) {
  const qrDataUrl = useMemo(
    () => (item ? renderQRDataURL(item.url, 260) : ''),
    [item?.url],
  );

  const switchRow = (
    <div class="relay-switch-row">
      <span class="relay-switch-label">收到新码自动跳转</span>
      <button
        type="button"
        class="relay-switch"
        role="switch"
        aria-checked={autoRedirect}
        aria-label="收到新码自动跳转"
        onClick={onToggleAutoRedirect}
      />
    </div>
  );

  if (!item) {
    return (
      <section class="card relay-card" aria-label="收码等待状态">
        <div class="relay-wait">
          <div class="relay-emblem">
            <Icon name="sparkle" size={26} />
          </div>
          <h2>等待教室发码</h2>
          <p>微信内可先设为浮窗，收到新码自动跳转</p>
          {peers.send > 0 ? (
            <span class="relay-wait-caption">
              <span class="relay-dot live" aria-hidden="true" />
              <span>发码端已就绪</span>
            </span>
          ) : null}
        </div>
        {switchRow}
      </section>
    );
  }

  const remain = remainSeconds(item.expiresAtLocal, nowMs);
  const redirectStatus = redirect.status.value;
  const alreadyRedirected = redirect.alreadyRedirected.value;

  const showAwaitingPrompt = redirectStatus === 'awaiting-focus';
  const showBlockedPrompt = redirectStatus === 'blocked';

  return (
    <section class="card relay-card" aria-label="当前有效签到码">
      {showAwaitingPrompt ? (
        <div
          class="redirect-prompt"
          role="alert"
          aria-live="assertive"
        >
          <div class="redirect-prompt-text">
            <span class="redirect-prompt-title">未获取焦点，轻触屏幕即可自动跳转</span>
            <span class="redirect-prompt-sub">
              剩余 {remain}s · 轻触空白处或点击按钮立即前往
            </span>
          </div>
          <button
            type="button"
            class="btn primary hero"
            onClick={() => redirect.tryExecute({ fromGesture: true })}
          >
            <Icon name="external" size={17} />
            <span>立即跳转</span>
          </button>
        </div>
      ) : null}

      {showBlockedPrompt ? (
        <div
          class="redirect-prompt blocked"
          role="alert"
          aria-live="assertive"
        >
          <div class="redirect-prompt-text">
            <span class="redirect-prompt-title">微信拦截了自动跳转，轻触立即前往</span>
            <span class="redirect-prompt-sub">
              剩余 {remain}s · 请直接点击下方按钮打开签到页
            </span>
          </div>
          <a
            class="btn primary hero"
            href={item.url}
            onClick={() => redirect.confirmManualJump(item)}
          >
            <Icon name="external" size={17} />
            <span>立即前往签到</span>
          </a>
        </div>
      ) : null}

      <div class="relay-active-head">
        <div class="relay-badges">
          <span class="relay-pill">{item.source}</span>
          <span
            id="relay-ttl"
            class={remain <= 15 ? 'relay-pill ttl urgent' : 'relay-pill ttl'}
          >
            {remain}s
          </span>
        </div>
        <button
          type="button"
          class="btn text"
          onClick={onClear}
        >
          清除
        </button>
      </div>

      <div class="stack-sm">
        <h2 class="relay-host">{item.host || '签到链接已就绪'}</h2>
        <p class="relay-url" title={item.url}>{item.url}</p>
      </div>

      {alreadyRedirected ? (
        <p class="relay-notice">
          本条链接已自动跳转过，可再次点击或长按二维码打开。
        </p>
      ) : null}

      <div class="relay-cta-col">
        <a
          class="btn primary hero"
          href={item.url}
          onClick={() => redirect.confirmManualJump(item)}
        >
          <Icon name="external" size={17} />
          <span>立即前往签到</span>
        </a>

        <div class="relay-link-row">
          <button
            type="button"
            class="btn text"
            onClick={async () => {
              const ok = await copyText(item.url);
              showToast(ok ? '已复制签到链接' : '复制失败，请手动长按链接');
            }}
          >
            复制链接
          </button>
          <span class="relay-sep" aria-hidden="true">·</span>
          <button
            type="button"
            class="btn text"
            onClick={() => onSwitchToSend(item.url, item.source)}
          >
            转去发码
          </button>
        </div>
      </div>

      {qrDataUrl ? (
        <div class="relay-qr-wrap">
          <div class="relay-qr-box">
            <img
              class="relay-qr-img"
              src={qrDataUrl}
              alt="签到二维码"
              width={196}
              height={196}
            />
          </div>
          <p class="hint center">长按二维码也可识别</p>
        </div>
      ) : null}

      {switchRow}
    </section>
  );
}
