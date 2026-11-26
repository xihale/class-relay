import { useMemo } from 'preact/hooks';
import type {
  ConnectionStatus,
  RelayItem,
  RoomPeers,
  TransportKind,
} from '../types/protocol';
import type { RedirectController } from '../lib/redirect';
import { renderQRDataURL } from '../lib/qr';
import { copyText, remainSeconds } from '../lib/storage';
import { Icon } from './TopBar';
import { showToast } from './ToastHost';

export interface ReceiverViewProps {
  item: RelayItem | null;
  nowMs: number;
  peers: RoomPeers;
  status: ConnectionStatus;
  transport: TransportKind;
  autoRedirect: boolean;
  redirect: RedirectController;
  onToggleAutoRedirect: () => void;
  onClear: () => void;
  onSwitchToSend: (url: string, source: string) => void;
}

function transportReadyText(
  status: ConnectionStatus,
  transport: TransportKind,
): { text: string; ready: boolean } {
  if (status === 'live') {
    if (transport === 'ws') return { text: 'WS 实时通道已就绪', ready: true };
    if (transport === 'sse') return { text: 'SSE 实时通道已就绪', ready: true };
    return { text: '长轮询通道已就绪', ready: true };
  }
  if (status === 'reconnecting') return { text: '正在重连实时通道…', ready: false };
  if (status === 'offline') return { text: '网络已断开，恢复后自动重连', ready: false };
  if (status === 'error') return { text: '通道异常，可点击右上角重连', ready: false };
  return { text: '正在建立实时通道…', ready: false };
}

export function ReceiverView({
  item,
  nowMs,
  peers,
  status,
  transport,
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
      <div class="relay-switch-text">
        <b>收到新码自动跳转</b>
        <span>使用 location.assign，保留微信左上角返回键</span>
      </div>
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
    const readyInfo = transportReadyText(status, transport);
    return (
      <section class="card relay-card" aria-label="收码等待状态">
        <div class="relay-wait">
          <div class="relay-emblem">
            <Icon name="sparkle" size={28} />
          </div>
          <h2>等待教室端传码</h2>
          <p>建议将本页设为微信「浮窗」，收到通知点回即可接力签到</p>
          <div class="relay-wait-meta">
            <span class={readyInfo.ready ? 'scan-badge ready' : 'scan-badge'}>
              <span
                class={readyInfo.ready ? 'relay-dot live' : 'relay-dot warn'}
                aria-hidden="true"
              />
              <span>{readyInfo.text}</span>
            </span>
            <span class="scan-badge">
              <Icon name="users" size={14} />
              <span>
                {peers.send > 0
                  ? `发码端在线 ${peers.send} · 共 ${peers.total} 人`
                  : `当前房间 ${peers.total} 人在线`}
              </span>
            </span>
          </div>
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
              剩余 {remain}s · 轻触页面任意空白处或点击下方按钮立即前往
            </span>
          </div>
          <button
            type="button"
            class="btn primary hero"
            onClick={() => redirect.tryExecute({ fromGesture: true })}
          >
            <Icon name="external" size={18} />
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
            <Icon name="external" size={18} />
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
            {remain}s 后过期
          </span>
        </div>
        <button
          type="button"
          class="btn small ghost"
          onClick={onClear}
        >
          清除
        </button>
      </div>

      <div class="stack-sm">
        <h2 class="relay-host">{item.host || '签到链接已就绪'}</h2>
        <p class="relay-url">{item.url}</p>
      </div>

      {alreadyRedirected ? (
        <p class="relay-notice">
          本条链接已自动跳转过；如需再次打开，请点击下方按钮或长按二维码。
        </p>
      ) : null}

      <div class="relay-cta-col">
        <a
          class="btn primary hero"
          href={item.url}
          onClick={() => redirect.confirmManualJump(item)}
        >
          <Icon name="external" size={18} />
          <span>立即前往签到</span>
        </a>

        <div class="relay-cta-sub">
          <button
            type="button"
            class="btn tonal"
            onClick={async () => {
              const ok = await copyText(item.url);
              showToast(ok ? '已复制签到链接' : '复制失败，请手动长按链接');
            }}
          >
            <Icon name="copy" size={16} />
            <span>复制链接</span>
          </button>

          <button
            type="button"
            class="btn"
            onClick={() => onSwitchToSend(item.url, item.source)}
          >
            切换到发码
          </button>
        </div>
      </div>

      {qrDataUrl ? (
        <div class="relay-qr-wrap">
          <img
            class="relay-qr-img"
            src={qrDataUrl}
            alt="签到二维码"
            width={220}
            height={220}
          />
          <p class="hint center">微信内可长按二维码直接识别前往</p>
        </div>
      ) : null}

      {switchRow}
    </section>
  );
}
