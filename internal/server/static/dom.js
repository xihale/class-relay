// 极简 DOM 辅助：不使用 innerHTML，所有文本均经 textContent，天然避免 XSS；
// 样式仅通过 CSS 类控制，满足严格 CSP (style-src 'self')。

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && !k.includes('-')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

// 24x24 线性图标，纯矢量不依赖外部资源。
const ICONS = {
  x: 'M6 6l12 12M18 6L6 18',
  right: 'M9 5l7 7-7 7',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  scan: 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M7 12h10',
  camera: 'M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  image: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 15l-4.5-4.5L7 19',
  copy: 'M9 9h10v10H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  shuffle: 'M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  send: 'M21 3L10 14M21 3l-7 18-4-7-7-4z',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  link: 'M10 13a5 5 0 0 0 7.1 0l2.8-2.8a5 5 0 0 0-7.1-7.1L11.2 4.7M14 11a5 5 0 0 0-7.1 0L4.1 13.8a5 5 0 0 0 7.1 7.1l1.6-1.6',
  check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l3 3 5-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

export function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.more);
  svg.append(p);
  return svg;
}

let toastHost = null;
export function toast(message, { action, onAction, ms = 4000 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: 'toast' }, h('span', {}, message));
  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (action) {
    el.append(h('button', {
      class: 'toast-action',
      type: 'button',
      onclick: () => { close(); if (onAction) onAction(); },
    }, action));
  }
  toastHost.append(el);
  timer = setTimeout(close, ms);
  return close;
}

export function openDialog(content, { onClose, wide = false, label = '' } = {}) {
  const dlg = h('dialog', { class: `sheet${wide ? ' wide' : ''}`, 'aria-label': label });
  const inner = h('div', { class: 'sheet-body' }, content);
  dlg.append(inner);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    dlg.remove();
    if (onClose) onClose();
  };
  dlg.addEventListener('close', finish);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close: () => { if (dlg.open) dlg.close(); else finish(); } };
}
