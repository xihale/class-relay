import type { Role } from '../types/protocol';

export interface ModeSwitchProps {
  mode: Role;
  onChange: (next: Role) => void;
}

export function ModeSwitch({ mode, onChange }: ModeSwitchProps) {
  return (
    <div class="seg mode-switch" role="group" aria-label="使用模式">
      <button
        type="button"
        class="seg-btn"
        aria-pressed={mode === 'recv'}
        onClick={() => onChange('recv')}
      >
        收码自动跳
      </button>
      <button
        type="button"
        class="seg-btn"
        aria-pressed={mode === 'send'}
        onClick={() => onChange('send')}
      >
        发码扫码端
      </button>
    </div>
  );
}
