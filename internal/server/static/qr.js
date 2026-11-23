// 轻量零依赖二维码生成器（ISO/IEC 18004 Byte 模式，EC Level L，支持 Version 1–15，最大 520 UTF-8 字节）。
// 输出为 PNG Data URL（用于 <img> 展示，确保微信内置浏览器长按图片可直接触发「识别图中二维码」）。

const VERSIONS = [
  null,
  [19, 7, 1, 19, 0, 0, []],
  [34, 10, 1, 34, 0, 0, [6, 18]],
  [55, 15, 1, 55, 0, 0, [6, 22]],
  [80, 20, 1, 80, 0, 0, [6, 26]],
  [108, 26, 1, 108, 0, 0, [6, 30]],
  [136, 18, 2, 68, 0, 0, [6, 34]],
  [156, 20, 2, 78, 0, 0, [6, 22, 38]],
  [194, 24, 2, 97, 0, 0, [6, 24, 42]],
  [232, 30, 2, 116, 0, 0, [6, 26, 46]],
  [274, 18, 2, 68, 2, 69, [6, 28, 50]],
  [324, 20, 4, 81, 0, 0, [6, 30, 54]],
  [370, 24, 2, 92, 2, 93, [6, 32, 58]],
  [428, 26, 4, 107, 0, 0, [6, 34, 62]],
  [461, 30, 3, 115, 1, 116, [6, 26, 46, 66]],
  [523, 22, 5, 87, 1, 88, [6, 26, 48, 70]],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGenerator(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return res.slice(data.length);
}

function encodeBits(bytes) {
  let ver = 0;
  for (let v = 1; v < VERSIONS.length; v++) {
    const countBits = v >= 10 ? 16 : 8;
    const dataBits = VERSIONS[v][0] * 8;
    if (4 + countBits + bytes.length * 8 <= dataBits) {
      ver = v;
      break;
    }
  }
  if (!ver) throw new Error('链接太长，超出二维码容量');

  const [totalData, ecLen, g1, d1, g2, d2] = VERSIONS[ver];
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  const capBits = totalData * 8;
  push(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const pad = [0xec, 0x11];
  for (let i = 0; bits.length < capBits; i++) push(pad[i & 1], 8);

  const dataCW = new Uint8Array(totalData);
  for (let i = 0; i < totalData; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    dataCW[i] = b;
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let off = 0;
  for (let i = 0; i < g1; i++) {
    const blk = dataCW.slice(off, off + d1);
    off += d1;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, ecLen));
  }
  for (let i = 0; i < g2; i++) {
    const blk = dataCW.slice(off, off + d2);
    off += d2;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, ecLen));
  }

  const out = [];
  const maxD = Math.max(d1, d2);
  for (let i = 0; i < maxD; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return { ver, codewords: out };
}

function bchFormat(ecBits, mask) {
  const data = (ecBits << 3) | mask;
  let rem = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= poly << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function bchVersion(ver) {
  let rem = ver << 12;
  const poly = 0x1f25;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= poly << (i - 12);
  }
  return (ver << 12) | rem;
}

function buildBaseMatrix(ver) {
  const size = 17 + 4 * ver;
  const grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const fixed = Array.from({ length: size }, () => new Uint8Array(size));

  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    grid[r][c] = v ? 1 : 0;
    fixed[r][c] = 1;
  };

  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
          && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(r0 + dr, c0 + dc, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const align = VERSIONS[ver][6];
  for (const ar of align) {
    for (const ac of align) {
      if (fixed[ar][ac]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          set(ar + dr, ac + dc, dark);
        }
      }
    }
  }

  set(size - 8, 8, 1);

  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      set(8, i, 0);
      set(i, 8, 0);
    }
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, 0);
    if (i < 7) set(size - 1 - i, 8, 0);
  }

  if (ver >= 7) {
    const vBits = bchVersion(ver);
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      set(r, c, bit);
      set(c, r, bit);
    }
  }

  return { size, grid, fixed };
}

function placeData(size, grid, fixed, codewords) {
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let up = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = up ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (fixed[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        grid[r][c] = bit;
      }
    }
    up = !up;
  }
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMaskAndFormat(size, baseGrid, fixed, maskId) {
  const fn = MASK_FNS[maskId];
  const m = baseGrid.map((row, r) => row.map((v, c) => (fixed[r][c] ? v : v ^ (fn(r, c) ? 1 : 0))));
  const fmt = bchFormat(0b01, maskId);
  for (let k = 0; k < 15; k++) {
    const bit = (fmt >> (14 - k)) & 1;
    if (k < 6) m[8][k] = bit;
    else if (k < 8) m[8][k + 1] = bit;
    else if (k === 8) m[7][8] = bit;
    else m[14 - k][8] = bit;

    if (k < 7) m[size - 1 - k][8] = bit;
    else m[8][size - 15 + k] = bit;
  }
  m[size - 8][8] = 1;
  return m;
}

function penalty(m) {
  const n = m.length;
  let score = 0;
  for (let r = 0; r < n; r++) {
    let runC = 1;
    let runR = 1;
    for (let i = 1; i < n; i++) {
      if (m[r][i] === m[r][i - 1]) runC++;
      else { if (runC >= 5) score += runC - 2; runC = 1; }
      if (m[i][r] === m[i - 1][r]) runR++;
      else { if (runR >= 5) score += runR - 2; runR = 1; }
    }
    if (runC >= 5) score += runC - 2;
    if (runR >= 5) score += runR - 2;
  }
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const s = m[r][c] + m[r][c + 1] + m[r + 1][c] + m[r + 1][c + 1];
      if (s === 0 || s === 4) score += 3;
    }
  }
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c];
  const pct = Math.abs((dark * 100) / (n * n) - 50);
  score += Math.floor(pct / 5) * 10;
  return score;
}

export function makeQRMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const { ver, codewords } = encodeBits(bytes);
  const { size, grid, fixed } = buildBaseMatrix(ver);
  placeData(size, grid, fixed, codewords);

  let best = null;
  let bestScore = Infinity;
  for (let id = 0; id < 8; id++) {
    const candidate = applyMaskAndFormat(size, grid, fixed, id);
    const sc = penalty(candidate);
    if (sc < bestScore) {
      bestScore = sc;
      best = candidate;
    }
  }
  return best;
}

export function renderQRDataURL(text, pxSize = 264) {
  const matrix = makeQRMatrix(text);
  const n = matrix.length;
  const quiet = 4;
  const total = n + quiet * 2;
  const scale = Math.max(4, Math.floor(pxSize / total));
  const dim = total * scale;

  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = '#182420';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return canvas.toDataURL('image/png');
}
