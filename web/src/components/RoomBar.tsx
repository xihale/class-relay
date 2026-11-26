import { useEffect, useState } from 'preact/hooks';
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
  onChangeRoom: (nextRoom: string) => void;
}

export function RoomBar({ room, onChangeRoom }: RoomBarProps) {
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

  return (
    <section
      class={expanded ? 'room-strip-wrap expanded' : 'room-strip-wrap'}
      aria-label="房间切换与分享"
    >
      <div class="room-strip">
        <button
          type="button"
          class="room-pill-btn"
          aria-expanded={expanded}
          aria-controls="room-drawer"
          onClick={() => setExpanded((v) => !v)}
        >
          <span class="room-hash" aria-hidden="true">#</span>
          <span class="room-code">{room}</span>
          <Icon name="down" size={14} class="room-toggle-icon" />
        </button>

        <button
          type="button"
          class="btn text"
          onClick={() => handleCopy('recv', '已复制房间分享链接')}
        >
          <Icon name="copy" size={14} />
          <span>分享链接</span>
        </button>
      </div>

      <div id="room-drawer" class="card room-drawer-card" hidden={!expanded}>
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
            <Icon name="shuffle" size={17} />
          </button>
          <button type="submit" class="btn small primary">进入</button>
        </form>

        <div class="room-links">
          <button
            type="button"
            class="btn small"
            onClick={() => handleCopy('recv', '已复制室友收码链接')}
          >
            <Icon name="copy" size={14} />
            <span>复制收码链接</span>
          </button>
          <button
            type="button"
            class="btn small"
            onClick={() => handleCopy('send', '已复制教室发码链接')}
          >
            <Icon name="link" size={14} />
            <span>复制发码链接</span>
          </button>
        </div>
      </div>
    </section>
  );
}
