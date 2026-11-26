import { useSignal, useSignalEffect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Preset, RelayItem, RelaySnapshot, Role } from './types/protocol';
import { createRelayTransport, type RelayTransport } from './lib/transport';
import { createRedirectController, type RedirectController } from './lib/redirect';
import {
  guessSource,
  initialMode,
  initialRoom,
  loadAutoRedirect,
  loadPresets,
  loadSource,
  loadTtl,
  loadWarmed,
  recordWarmed,
  remainSeconds,
  saveAutoRedirect,
  savePresets,
  saveSource,
  saveTtl,
  syncUrl,
} from './lib/storage';
import { disposeScannerResources, extractUrl } from './lib/scanner';
import { cycleTheme, themeMode } from './lib/theme';
import { TopBar } from './components/TopBar';
import { ModeSwitch } from './components/ModeSwitch';
import { RoomBar } from './components/RoomBar';
import { ReceiverView } from './components/ReceiverView';
import { SenderView } from './components/SenderView';
import { PrewarmSection } from './components/PrewarmSection';
import { PresetEditModal } from './components/PresetEditModal';
import { CameraScannerModal } from './components/CameraScannerModal';
import { ToastHost, showToast } from './components/ToastHost';

const NON_TAP_JUMP_SELECTOR =
  'button, a, input, textarea, [role="switch"], .room-strip-wrap, .room-drawer-card, .prewarm-card, .mode-switch, dialog';

export function App() {
  const [room, setRoom] = useState<string>(() => initialRoom());
  const [mode, setMode] = useState<Role>(() => initialMode());
  const [autoRedirect, setAutoRedirect] = useState<boolean>(() => loadAutoRedirect());

  const [senderUrl, setSenderUrl] = useState('');
  const [senderSource, setSenderSource] = useState<string>(() => loadSource());
  const [senderTtl, setSenderTtl] = useState<number>(() => loadTtl());
  const [senderBusy, setSenderBusy] = useState(false);
  const [senderError, setSenderError] = useState('');

  const [presets, setPresets] = useState<Preset[]>(() => loadPresets());
  const [warmed, setWarmed] = useState(() => loadWarmed());
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastDeliveredKeyRef = useRef<string>('');
  const lastExpiredKeyRef = useRef<string>('');
  const lastTapJumpAtRef = useRef<number>(0);

  const modeRef = useRef<Role>(mode);
  modeRef.current = mode;
  const roomRef = useRef<string>(room);
  roomRef.current = room;
  const autoRedirectRef = useRef<boolean>(autoRedirect);
  autoRedirectRef.current = autoRedirect;

  const transportRef = useRef<RelayTransport | null>(null);
  if (!transportRef.current) {
    transportRef.current = createRelayTransport();
  }
  const transport = transportRef.current;

  const redirectRef = useRef<RedirectController | null>(null);
  if (!redirectRef.current) {
    redirectRef.current = createRedirectController({
      onJumped: (seq: number) => {
        transport.sendReceipt(seq, 'jumped');
      },
    });
  }
  const redirect = redirectRef.current;

  const nowMs = useSignal<number>(Date.now());

  // Subscribe to transport snapshots once
  useEffect(() => {
    const unsub = transport.onSnapshot((_snap: RelaySnapshot, item: RelayItem | null) => {
      const curRoom = roomRef.current;
      const curMode = modeRef.current;
      const curAuto = autoRedirectRef.current;

      if (item && curMode === 'recv') {
        const key = `${curRoom}:${item.seq}`;
        if (lastDeliveredKeyRef.current !== key) {
          lastDeliveredKeyRef.current = key;
          transport.sendReceipt(item.seq, 'delivered');
        }
      }

      redirect.handleIncoming(curRoom, item, {
        mode: curMode,
        autoRedirect: curAuto,
      });
    });

    const onPageHide = () => {
      disposeScannerResources();
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      unsub();
      window.removeEventListener('pagehide', onPageHide);
      transport.disconnect();
      redirect.dispose();
      disposeScannerResources();
    };
  }, [transport, redirect]);

  // Connect whenever room changes
  useEffect(() => {
    syncUrl(room, modeRef.current);
    lastDeliveredKeyRef.current = '';
    lastExpiredKeyRef.current = '';
    redirect.reset();
    transport.connect(room, modeRef.current);
  }, [room, transport, redirect]);

  // Update role & URL when mode changes
  useEffect(() => {
    syncUrl(roomRef.current, mode);
    transport.setRole(mode);
    const item = transport.activeItem.value;
    if (mode === 'recv' && item) {
      const key = `${roomRef.current}:${item.seq}`;
      if (lastDeliveredKeyRef.current !== key) {
        lastDeliveredKeyRef.current = key;
        transport.sendReceipt(item.seq, 'delivered');
      }
      redirect.handleIncoming(roomRef.current, item, {
        mode: 'recv',
        autoRedirect: autoRedirectRef.current,
      });
    } else if (mode === 'send') {
      redirect.reset();
    }
  }, [mode, transport, redirect]);

  // Probe wakeup & refresh prewarm state when returning to foreground
  useSignalEffect(() => {
    const isVisible = redirect.visible.value;
    if (isVisible) {
      nowMs.value = Date.now();
      setWarmed(loadWarmed());
      transport.probeWakeup();
    }
  });

  // Shared 1s countdown ticker — runs ONLY when activeItem && visible!
  useSignalEffect(() => {
    const item = transport.activeItem.value;
    const isVisible = redirect.visible.value;
    if (!item || !isVisible) return;

    nowMs.value = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      nowMs.value = now;
      const current = transport.activeItem.value;
      if (current && remainSeconds(current.expiresAtLocal, now) <= 0) {
        const expKey = `${current.room}:${current.seq}`;
        if (lastExpiredKeyRef.current !== expKey) {
          lastExpiredKeyRef.current = expKey;
          redirect.reset();
          if (modeRef.current === 'recv') {
            showToast('签到码已过期，继续等待新码');
          }
        }
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  });

  const handleRoomChange = (nextRoom: string) => {
    if (nextRoom === room) return;
    setRoom(nextRoom);
    showToast(`已切换到房间 ${nextRoom}`);
  };

  const handleToggleAutoRedirect = () => {
    const next = !autoRedirect;
    setAutoRedirect(next);
    saveAutoRedirect(next);
    if (!next) {
      redirect.reset();
    } else {
      const item = transport.activeItem.value;
      if (item && mode === 'recv') {
        redirect.handleIncoming(room, item, { mode: 'recv', autoRedirect: true });
      }
    }
  };

  const handleSourceChange = (val: string) => {
    setSenderSource(val);
    saveSource(val);
  };

  const handleTtlChange = (val: number) => {
    setSenderTtl(val);
    saveTtl(val);
  };

  const handlePush = async (
    url: string,
    source: string,
    ttlSec: number,
  ): Promise<boolean> => {
    setSenderBusy(true);
    setSenderError('');
    try {
      await transport.push({ url, source, ttlSec });
      setSenderUrl(url);
      showToast(`已发送到房间 ${roomRef.current}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : '发送失败，请稍后重试';
      setSenderError(msg);
      showToast(msg);
      return false;
    } finally {
      setSenderBusy(false);
    }
  };

  const handleClear = async () => {
    try {
      await transport.clear();
      redirect.reset();
      showToast('已清除当前签到码');
    } catch {
      showToast('清除失败，请稍后重试');
    }
  };

  const handleCameraResult = async (rawText: string) => {
    setCameraOpen(false);
    const text = String(rawText || '').trim();
    const extracted = extractUrl(text);
    if (!extracted) {
      setSenderUrl(text);
      setSenderError('二维码内容不包含 http(s):// 链接，已填入下方文本框供核对');
      showToast('未识别到网址，请检查二维码内容');
      return;
    }
    setSenderUrl(extracted);
    setSenderError('');
    const detected = guessSource(extracted, senderSource);
    if (detected !== senderSource) {
      handleSourceChange(detected);
    }
    await handlePush(extracted, detected, senderTtl);
  };

  const handlePrewarm = (preset: Preset) => {
    if (!preset.url) {
      setEditingPreset(preset);
      return;
    }
    setWarmed(recordWarmed(preset.id));
    window.location.assign(preset.url);
  };

  const handleSavePreset = (presetId: string, url: string) => {
    const next = presets.map((p) => (p.id === presetId ? { ...p, url } : p));
    setPresets(next);
    savePresets(next);
    showToast('已保存预热入口');
  };

  const handleStatusAction = () => {
    if (redirect.isTapJumpArmed.value) {
      redirect.tryExecute({ fromGesture: true });
      return;
    }
    const st = transport.status.value;
    if (st === 'offline' || st === 'error') {
      transport.reconnect();
    }
  };

  const handleShellTap = (e: Event) => {
    if (!redirect.isTapJumpArmed.value) return;
    if (e.target instanceof Element && e.target.closest(NON_TAP_JUMP_SELECTOR)) {
      return;
    }
    const now = Date.now();
    if (now - lastTapJumpAtRef.current < 350) return;
    lastTapJumpAtRef.current = now;
    redirect.tryExecute({ fromGesture: true });
  };

  const rawActiveItem = transport.activeItem.value;
  const activeItem =
    rawActiveItem && remainSeconds(rawActiveItem.expiresAtLocal, nowMs.value) > 0
      ? rawActiveItem
      : null;

  const isTapJumpArmed = redirect.isTapJumpArmed.value;

  return (
    <div
      class={isTapJumpArmed ? 'relay-shell tap-jump-active' : 'relay-shell'}
      onPointerUp={handleShellTap}
      onClick={handleShellTap}
    >
      <main class="relay-wrap">
        <TopBar
          status={transport.status.value}
          transport={transport.transport.value}
          rttMs={transport.rttMs.value}
          errorText={transport.errorText.value}
          peers={transport.peers.value}
          redirectStatus={redirect.status.value}
          isTapJumpArmed={isTapJumpArmed}
          theme={themeMode.value}
          onCycleTheme={cycleTheme}
          onStatusAction={handleStatusAction}
        />

        <ModeSwitch mode={mode} onChange={setMode} />

        <RoomBar
          room={room}
          onChangeRoom={handleRoomChange}
        />

        {mode === 'recv' ? (
          <ReceiverView
            item={activeItem}
            nowMs={nowMs.value}
            peers={transport.peers.value}
            autoRedirect={autoRedirect}
            redirect={redirect}
            onToggleAutoRedirect={handleToggleAutoRedirect}
            onClear={() => void handleClear()}
            onSwitchToSend={(url, source) => {
              setSenderUrl(url);
              if (source) handleSourceChange(source);
              setMode('send');
            }}
          />
        ) : (
          <SenderView
            room={room}
            activeItem={activeItem}
            nowMs={nowMs.value}
            peers={transport.peers.value}
            receipts={transport.receipts.value}
            url={senderUrl}
            source={senderSource}
            ttl={senderTtl}
            busy={senderBusy}
            error={senderError}
            onUrlChange={setSenderUrl}
            onSourceChange={handleSourceChange}
            onTtlChange={handleTtlChange}
            onErrorChange={setSenderError}
            onPush={handlePush}
            onClear={handleClear}
            onOpenCamera={() => setCameraOpen(true)}
            fileInputRef={fileInputRef}
          />
        )}

        {mode === 'recv' ? (
          <PrewarmSection
            presets={presets}
            warmed={warmed}
            onEdit={(p) => setEditingPreset(p)}
            onPrewarm={handlePrewarm}
          />
        ) : null}

        <aside class="relay-footer-note">
          纯内存临时转发 · 过期自动清除
        </aside>
      </main>

      <PresetEditModal
        preset={editingPreset}
        onClose={() => setEditingPreset(null)}
        onSave={handleSavePreset}
      />

      <CameraScannerModal
        open={cameraOpen}
        onResult={(text) => void handleCameraResult(text)}
        onPickFile={() => {
          setCameraOpen(false);
          fileInputRef.current?.click();
        }}
        onClose={() => setCameraOpen(false)}
      />

      <ToastHost />
    </div>
  );
}
