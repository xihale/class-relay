import { useEffect, useState } from 'preact/hooks';
import {
  VALID_ROOM_RE,
  buildShareUrl,
  copyText,
  loadRecentRooms,
  randomRoomId,
  recordRecentRoom,
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
  const [recentRooms, setRecentRooms] = useState<string[]>(() => loadRecentRooms());

  useEffect(() => {
    setDraft(room);
    setRecentRooms(recordRecentRoom(room));
  }, [room]);

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const cleaned = draft.trim();
    if (!VALID_ROOM_RE.test(cleaned)) {
      showToast('房间号需为 3~32 位数字、字母、- 或 _');
      return;
    }
    onChangeRoom(cleaned);
    setExpanded(false);
  };

  const handleCopyText = async (text: string, okText: string) => {
    const ok = await copyText(text);
    showToast(ok ? okText : '复制失败，请手动复制');
  };

  const otherRecent = recentRooms.filter((r) => r !== room).slice(0, 4);

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
          <span class="room-prefix">房间</span>
          <span class="room-code">{room}</span>
          <Icon name="down" size={14} class="room-toggle-icon" />
        </button>

        <button
          type="button"
          class="btn text"
          onClick={() => handleCopyText(buildShareUrl(room, 'recv'), '已复制房间分享链接')}
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
            enterKeyHint="go"
            spellcheck={false}
            placeholder="输入 3~6 位数字或口令"
            onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
            onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          />
          <button
            type="button"
            class="icon-btn"
            title="随机换一个房号"
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

        {otherRecent.length > 0 ? (
          <div class="room-recent" aria-label="最近房间">
            <span class="room-recent-label">最近</span>
            <div class="room-recent-list">
              {otherRecent.map((item) => (
                <button
                  key={item}
                  type="button"
                  class="room-recent-chip"
                  onClick={() => {
                    onChangeRoom(item);
                    setExpanded(false);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div class="room-links">
          <button
            type="button"
            class="btn small"
            onClick={() => handleCopyText(room, `已复制房号 ${room}`)}
          >
            <Icon name="copy" size={14} />
            <span>复制房号</span>
          </button>
          <button
            type="button"
            class="btn small"
            onClick={() => handleCopyText(buildShareUrl(room, 'recv'), '已复制室友收码链接')}
          >
            <Icon name="link" size={14} />
            <span>收码链接</span>
          </button>
          <button
            type="button"
            class="btn small"
            onClick={() => handleCopyText(buildShareUrl(room, 'send'), '已复制教室发码链接')}
          >
            <Icon name="send" size={14} />
            <span>发码链接</span>
          </button>
        </div>
      </div>
    </section>
  );
}
