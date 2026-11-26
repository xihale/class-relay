// Zero-dependency ISO/IEC 18004 QR generator (Byte mode, EC Level L, Versions 1-15, up to 520 UTF-8 bytes).
// Outputs PNG Data URL for <img> rendering so WeChat long-press recognition works natively.

type VersionSpec = [number, number, number, number, number, number, number[]];

const VERSIONS: Array<VersionSpec | null> = [
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

const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];

const RS_GEN_CACHE = new Map<number, Uint8Array>();

function rsGenerator(degree: number): Uint8Array {
  const cached = RS_GEN_CACHE.get(degree);
  if (cached) return cached;
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
  RS_GEN_CACHE.set(degree, poly);
  return poly;
}

function rsRemainder(data: Uint8Array, ecLen: number): Uint8Array {
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

function encodeBits(bytes: Uint8Array): { ver: number; codewords: number[] } {
  let ver = 0;
  for (let v = 1; v < VERSIONS.length; v++) {
    const spec = VERSIONS[v]!;
    const countBits = v >= 10 ? 16 : 8;
    const dataBits = spec[0] * 8;
    if (4 + countBits + bytes.length * 8 <= dataBits) {
      ver = v;
      break;
    }
  }
  if (!ver) throw new Error('链接太长，超出二维码容量');

  const [totalData, ecLen, g1, d1, g2, d2] = VERSIONS[ver]!;
  const bits: number[] = [];
  const push = (val: number, len: number) => {
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

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let off = 0;
  for (let i = 0; i < g1; i++) {
    const blk = dataCW.subarray(off, off + d1);
    off += d1;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, ecLen));
  }
  for (let i = 0; i < g2; i++) {
    const blk = dataCW.subarray(off, off + d2);
    off += d2;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, ecLen));
  }

  const out: number[] = [];
  const maxD = Math.max(d1, d2);
  for (let i = 0; i < maxD; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return { ver, codewords: out };
}

function bchFormat(ecBits: number, mask: number): number {
  const data = (ecBits << 3) | mask;
  let rem = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= poly << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function bchVersion(ver: number): number {
  let rem = ver << 12;
  const poly = 0x1f25;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= poly << (i - 12);
  }
  return (ver << 12) | rem;
}

function buildBaseMatrix(ver: number): { size: number; grid: Uint8Array; fixed: Uint8Array } {
  const size = 17 + 4 * ver;
  const grid = new Uint8Array(size * size);
  const fixed = new Uint8Array(size * size);

  const set = (r: number, c: number, v: boolean | number) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    const idx = r * size + c;
    grid[idx] = v ? 1 : 0;
    fixed[idx] = 1;
  };

  const finder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const dark =
          dr >= 0 &&
          dr <= 6 &&
          dc >= 0 &&
          dc <= 6 &&
          (dr === 0 ||
            dr === 6 ||
            dc === 0 ||
            dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
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

  const align = VERSIONS[ver]![6];
  for (const ar of align) {
    for (const ac of align) {
      if (fixed[ar * size + ac]) continue;
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

function placeData(
  size: number,
  grid: Uint8Array,
  fixed: Uint8Array,
  codewords: number[],
): void {
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let up = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = up ? size - 1 - step : step;
      const rowOff = r * size;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        const idx = rowOff + c;
        if (fixed[idx]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        grid[idx] = bit;
      }
    }
    up = !up;
  }
}

const MASK_FNS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMaskAndFormatInto(
  out: Uint8Array,
  size: number,
  baseGrid: Uint8Array,
  fixed: Uint8Array,
  maskId: number,
): void {
  const fn = MASK_FNS[maskId];
  for (let r = 0; r < size; r++) {
    const rowOff = r * size;
    for (let c = 0; c < size; c++) {
      const idx = rowOff + c;
      const v = baseGrid[idx];
      out[idx] = fixed[idx] ? v : v ^ (fn(r, c) ? 1 : 0);
    }
  }
  const fmt = bchFormat(0b01, maskId);
  for (let k = 0; k < 15; k++) {
    const bit = (fmt >> (14 - k)) & 1;
    if (k < 6) out[8 * size + k] = bit;
    else if (k < 8) out[8 * size + (k + 1)] = bit;
    else if (k === 8) out[7 * size + 8] = bit;
    else out[(14 - k) * size + 8] = bit;

    if (k < 7) out[(size - 1 - k) * size + 8] = bit;
    else out[8 * size + (size - 15 + k)] = bit;
  }
  out[(size - 8) * size + 8] = 1;
}

// ISO/IEC 18004 Rule 3 bitmasks (11-bit sliding window):
// 10111010000 (0x5d0) and 00001011101 (0x05d)
const RULE3_A = 0b10111010000;
const RULE3_B = 0b00001011101;
const RULE3_MASK = 0x7ff;

function penalty(m: Uint8Array, n: number): number {
  let score = 0;

  for (let r = 0; r < n; r++) {
    const rowOff = r * n;
    let runH = 1;
    let runV = 1;
    let winH = m[rowOff];
    let winV = m[r];
    for (let i = 1; i < n; i++) {
      const ch = m[rowOff + i];
      if (ch === m[rowOff + i - 1]) runH++;
      else {
        if (runH >= 5) score += runH - 2;
        runH = 1;
      }
      winH = ((winH << 1) | ch) & RULE3_MASK;
      if (i >= 10 && (winH === RULE3_A || winH === RULE3_B)) score += 40;

      const cv = m[i * n + r];
      if (cv === m[(i - 1) * n + r]) runV++;
      else {
        if (runV >= 5) score += runV - 2;
        runV = 1;
      }
      winV = ((winV << 1) | cv) & RULE3_MASK;
      if (i >= 10 && (winV === RULE3_A || winV === RULE3_B)) score += 40;
    }
    if (runH >= 5) score += runH - 2;
    if (runV >= 5) score += runV - 2;
  }

  for (let r = 0; r < n - 1; r++) {
    const row0 = r * n;
    const row1 = row0 + n;
    for (let c = 0; c < n - 1; c++) {
      const s = m[row0 + c] + m[row0 + c + 1] + m[row1 + c] + m[row1 + c + 1];
      if (s === 0 || s === 4) score += 3;
    }
  }

  let dark = 0;
  const total = n * n;
  for (let i = 0; i < total; i++) dark += m[i];
  const pct = Math.abs((dark * 100) / total - 50);
  score += Math.floor(pct / 5) * 10;
  return score;
}

export interface QRMatrix {
  size: number;
  data: Uint8Array;
}

export function makeQRMatrix(text: string): QRMatrix {
  const bytes = new TextEncoder().encode(text);
  const { ver, codewords } = encodeBits(bytes);
  const { size, grid, fixed } = buildBaseMatrix(ver);
  placeData(size, grid, fixed, codewords);

  const work = new Uint8Array(size * size);
  let bestId = 0;
  let bestScore = Infinity;
  for (let id = 0; id < 8; id++) {
    applyMaskAndFormatInto(work, size, grid, fixed, id);
    const sc = penalty(work, size);
    if (sc < bestScore) {
      bestScore = sc;
      bestId = id;
    }
  }
  applyMaskAndFormatInto(work, size, grid, fixed, bestId);
  return { size, data: work };
}

const QR_CACHE_MAX = 8;
const qrCache = new Map<string, string>();

export function clearQRCache(): void {
  qrCache.clear();
}

export function renderQRDataURL(text: string, pxSize = 260): string {
  const key = `${pxSize}:${text}`;
  const cached = qrCache.get(key);
  if (cached !== undefined) {
    qrCache.delete(key);
    qrCache.set(key, cached);
    return cached;
  }

  const { size: n, data } = makeQRMatrix(text);
  const quiet = 4;
  const total = n + quiet * 2;
  const scale = Math.max(4, Math.floor(pxSize / total));
  const dim = total * scale;

  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.width = 0;
    canvas.height = 0;
    return '';
  }

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = '#182420';
  ctx.beginPath();
  for (let r = 0; r < n; r++) {
    const rowOff = r * n;
    const py = (r + quiet) * scale;
    for (let c = 0; c < n; c++) {
      if (data[rowOff + c]) {
        ctx.rect((c + quiet) * scale, py, scale, scale);
      }
    }
  }
  ctx.fill();

  const url = canvas.toDataURL('image/png');
  canvas.width = 0;
  canvas.height = 0;

  qrCache.set(key, url);
  if (qrCache.size > QR_CACHE_MAX) {
    const oldest = qrCache.keys().next().value;
    if (oldest !== undefined) qrCache.delete(oldest);
  }
  return url;
}
