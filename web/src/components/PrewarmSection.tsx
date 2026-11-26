import { useState } from 'preact/hooks';
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
  const [expanded, setExpanded] = useState(false);

  return (
    <section
      class={expanded ? 'card prewarm-card expanded' : 'card prewarm-card'}
      aria-label="课前预热"
    >
      <button
        type="button"
        class="prewarm-toggle"
        aria-expanded={expanded}
        aria-controls="prewarm-list"
        onClick={() => setExpanded((v) => !v)}
      >
        <div class="prewarm-toggle-left">
          <span class="prewarm-title">课前预热</span>
          <span class="prewarm-summary">
            {latestWarmedSummary(warmed, presets)}
          </span>
        </div>
        <Icon name="down" size={16} class="prewarm-chevron" />
      </button>

      <div id="prewarm-list" class="relay-prewarm-list" hidden={!expanded}>
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
                  <Icon name="edit" size={16} />
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
