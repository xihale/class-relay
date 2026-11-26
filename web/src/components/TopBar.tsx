import type { ConnectionStatus, RedirectStatus, TransportKind } from '../types/protocol';
import type { ThemeMode } from '../lib/theme';

const ICONS = {
  x: 'M6 6l12 12M18 6L6 18',
  right: 'M9 5l7 7-7 7',
  down: 'M6 9l6 6 6-6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  scan: 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M7 12h10',
  camera: 'M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  flash: 'M13 2L4 14h7l-1 8 9-12h-7z',
  image: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 15l-4.5-4.5L7 19',
  copy: 'M9 9h10v10H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  shuffle: 'M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  send: 'M21 3L10 14M21 3l-7 18-4-7-7-4z',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  link: 'M10 13a5 5 0 0 0 7.1 0l2.8-2.8a5 5 0 0 0-7.1-7.1L11.2 4.7M14 11a5 5 0 0 0-7.1 0L4.1 13.8a5 5 0 0 0 7.1 7.1l1.6-1.6',
  check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l3 3 5-6',
  refresh: 'M20 11a8 8 0 1 0 2 5.3M20 4v7h-7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sun: 'M12 4V2M12 22v-2M4.93 4.93L3.51 3.51M20.49 20.49l-1.42-1.42M4 12H2M22 12h-2M4.93 19.07l-1.42 1.42M20.49 3.51l-1.42 1.42M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
  monitor: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zM8 21h8M12 17v4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 20,
  class: cls,
}: {
  name: IconName;
  size?: number;
  class?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={cls ? `icon ${cls}` : 'icon'}
    >
      <path d={ICONS[name] || ICONS.more} />
    </svg>
  );
}

export interface TopBarProps {
  status: ConnectionStatus;
  transport: TransportKind;
  rttMs: number | null;
  errorText: string;
  redirectStatus: RedirectStatus;
  isTapJumpArmed: boolean;
  theme: ThemeMode;
  onCycleTheme: () => void;
  onStatusAction: () => void;
}

function getChipState(props: TopBarProps): {
  label: string;
  dotClass: string;
  chipClass: string;
  interactive: boolean;
} {
  if (props.isTapJumpArmed) {
    if (props.redirectStatus === 'blocked') {
      return {
        label: '待轻触跳转',
        dotClass: 'relay-dot err',
        chipClass: 'sync-chip interactive err-chip',
        interactive: true,
      };
    }
    return {
      label: '待轻触跳转',
      dotClass: 'relay-dot warn',
      chipClass: 'sync-chip interactive warn-chip',
      interactive: true,
    };
  }

  if (props.status === 'offline') {
    return {
      label: '网络已断开 · 点此重连',
      dotClass: 'relay-dot err',
      chipClass: 'sync-chip interactive err-chip',
      interactive: true,
    };
  }

  if (props.status === 'error') {
    return {
      label: props.errorText || '连接异常 · 点此重连',
      dotClass: 'relay-dot err',
      chipClass: 'sync-chip interactive err-chip',
      interactive: true,
    };
  }

  if (props.status === 'reconnecting') {
    return {
      label: '重连中…',
      dotClass: 'relay-dot warn',
      chipClass: 'sync-chip',
      interactive: false,
    };
  }

  if (props.status === 'connecting') {
    return {
      label: '连接中…',
      dotClass: 'relay-dot',
      chipClass: 'sync-chip',
      interactive: false,
    };
  }

  if (props.transport === 'ws') {
    const label = props.rttMs !== null ? `WS · ${Math.round(props.rttMs)}ms` : 'WS';
    return {
      label,
      dotClass: 'relay-dot live',
      chipClass: 'sync-chip',
      interactive: false,
    };
  }

  if (props.transport === 'sse') {
    return {
      label: 'SSE',
      dotClass: 'relay-dot live',
      chipClass: 'sync-chip',
      interactive: false,
    };
  }

  return {
    label: '长轮询',
    dotClass: 'relay-dot active',
    chipClass: 'sync-chip',
    interactive: false,
  };
}

function themeMeta(mode: ThemeMode): { icon: IconName; label: string } {
  if (mode === 'light') return { icon: 'sun', label: '浅色主题（点击切换）' };
  if (mode === 'dark') return { icon: 'moon', label: '深色主题（点击切换）' };
  return { icon: 'monitor', label: '跟随系统主题（点击切换）' };
}

export function TopBar(props: TopBarProps) {
  const chip = getChipState(props);
  const tm = themeMeta(props.theme);

  return (
    <header class="relay-topbar">
      <div class="relay-brand">
        <img
          class="relay-logo"
          src="/icon.svg"
          alt="课堂接力"
          width={36}
          height={36}
        />
        <div class="relay-title-col">
          <h1>课堂接力</h1>
          <span class="relay-subtitle">Class Relay · 实时接力</span>
        </div>
      </div>

      <div class="topbar-actions">
        <button
          type="button"
          id="relay-status-chip"
          class={chip.chipClass}
          disabled={!chip.interactive}
          aria-live="polite"
          onClick={chip.interactive ? props.onStatusAction : undefined}
        >
          <span class={chip.dotClass} aria-hidden="true" />
          <span>{chip.label}</span>
        </button>

        <button
          type="button"
          class="icon-btn"
          aria-label={tm.label}
          title={tm.label}
          onClick={props.onCycleTheme}
        >
          <Icon name={tm.icon} size={18} />
        </button>
      </div>
    </header>
  );
}
