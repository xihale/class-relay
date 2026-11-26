import type { Preset, WarmedMap } from '../types/protocol';
import { formatAgo, latestWarmedSummary } from '../lib/storage';
import { Icon } from './TopBar';

export interface PrewarmSectionProps {
  presets: Preset[];
  warmed: WarmedMap;
  onEdit: (preset: Preset) => void;
  onPrewarm: (preset: Preset) => void;
}

export function PrewarmSection({
  presets,
  warmed,
  onEdit,
  onPrewarm,
}: PrewarmSectionProps) {
  return (
    <section class="relay-section" aria-label="课前预热">
      <div class="relay-section-head">
        <span class="relay-section-title">课前预热</span>
        <span class="relay-section-status">
          {latestWarmedSummary(warmed, presets)}
        </span>
      </div>

      <div class="relay-prewarm-list">
        {presets.map((p) => {
          const warmedAt = warmed[p.id];
          const sub = p.url || p.hint;
          return (
            <div class="relay-prewarm-row" key={p.id}>
              <div class="relay-prewarm-meta">
                <div class="relay-prewarm-name">
                  <span>{p.name}</span>
                  {typeof warmedAt === 'number' ? (
                    <span class="relay-prewarm-tag">{formatAgo(warmedAt)}</span>
                  ) : null}
                </div>
                <span class="relay-prewarm-sub">{sub}</span>
              </div>

              <div class="relay-prewarm-actions">
                <button
                  type="button"
                  class="icon-btn"
                  aria-label={`编辑 ${p.name} 入口`}
                  onClick={() => onEdit(p)}
                >
                  <Icon name="edit" size={18} />
                </button>
                <button
                  type="button"
                  class="btn small tonal"
                  onClick={() => onPrewarm(p)}
                >
                  {p.url ? '去预热' : '配置'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
