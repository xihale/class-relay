import { useEffect, useState } from 'preact/hooks';
import type { RoomPeers } from '../types/protocol';
import {
  VALID_ROOM_RE,
  buildShareUrl,
  copyText,
  randomRoomId,
} from '../lib/storage';
import { Icon } from './TopBar';
import { showToast } from './ToastHost';

export interface RoomBarProps {
  room: string;
  peers: RoomPeers;
  onChangeRoom: (nextRoom: string) => void;
}

export function RoomBar({ room, peers, onChangeRoom }: RoomBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(room);

  useEffect(() => {
    setDraft(room);
  }, [room]);

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const cleaned = draft.trim();
    if (!VALID_ROOM_RE.test(cleaned)) {
      showToast('房间号需为 3~32 位字母、数字、- 或 _');
      return;
    }
    onChangeRoom(cleaned);
    setExpanded(false);
  };

  const handleCopy = async (targetMode: 'recv' | 'send', okText: string) => {
    const ok = await copyText(buildShareUrl(room, targetMode));
    showToast(ok ? okText : '复制失败，请手动复制地址栏');
  };

  const onlineCount = Math.max(0, peers.total);

  return (
    <section
      class={expanded ? 'card room-bar expanded' : 'card room-bar'}
      aria-label="房间设置与分享"
    >
      <div class="room-summary">
        <div class="room-summary-main">
          <span class="room-label">房间</span>
          <span class="room-code">{room}</span>
          <span class="room-peers-pill" aria-live="polite">
            <span class={onlineCount > 0 ? 'relay-dot live' : 'relay-dot'} aria-hidden="true" />
            <span>{onlineCount} 人在线</span>
          </span>
        </div>

        <div class="room-summary-actions">
          <button
            type="button"
            class="btn small tonal"
            onClick={() => handleCopy('recv', '已复制室友收码链接')}
          >
            <Icon name="copy" size={15} />
            <span>复制链接</span>
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label={expanded ? '收起房间设置' : '展开房间设置'}
            aria-expanded={expanded}
            aria-controls="room-drawer"
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name="down" size={18} class="room-toggle-icon" />
          </button>
        </div>
      </div>

      <div id="room-drawer" class="room-drawer" hidden={!expanded}>
        <form class="room-form" onSubmit={handleSubmit}>
          <label class="sr-only" for="room-id-input">房间号</label>
          <input
            id="room-id-input"
            type="text"
            class="input room-input"
            value={draft}
            maxLength={32}
            autoComplete="off"
            spellcheck={false}
            placeholder="输入房间号（3~32位）"
            onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          />
          <button
            type="button"
            class="icon-btn"
            title="随机房间号"
            aria-label="生成随机房间号"
            onClick={() => {
              const next = randomRoomId();
              setDraft(next);
              onChangeRoom(next);
            }}
          >
            <Icon name="shuffle" size={18} />
          </button>
          <button type="submit" class="btn small primary">进入</button>
        </form>

        <div class="room-links">
          <button
            type="button"
            class="btn small"
            onClick={() => handleCopy('recv', '已复制室友收码链接')}
          >
            <Icon name="copy" size={16} />
            <span>复制收码链接</span>
          </button>
          <button
            type="button"
            class="btn small"
            onClick={() => handleCopy('send', '已复制教室发码链接')}
          >
            <Icon name="link" size={16} />
            <span>复制发码链接</span>
          </button>
        </div>
      </div>
    </section>
  );
}
