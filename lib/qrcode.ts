// Pure QR Code encoder — NO imports, so it can run on the server
// (print-job module maps for the kitchen printer app) and in the
// browser (kitchen board / admin panel rendering) with identical
// output. Scope: byte mode, error-correction level M, versions 1–6
// (up to 106 bytes — a driver link is ~65). The matrix it returns is
// the raw module grid (no quiet zone); renderers add their own.
//
// Written from the QR specification (Thonky's tutorial tables for
// level M) and verified in this repo by decoding generated codes
// back to their source strings with an independent decoder.

export interface QrMatrix {
  /** Modules per side (21 + 4 × (version − 1)). */
  size: number;
  /** Row-major module grid; true = dark module. */
  modules: boolean[];
}

// ---- Level-M structure tables (versions 1–6) --------------------------------

const EC_PER_BLOCK: Record<number, number> = {
  1: 10,
  2: 16,
  3: 26,
  4: 18,
  5: 24,
  6: 16,
};

/** [block count, data codewords per block] groups, in order. */
const BLOCK_GROUPS: Record<number, [number, number][]> = {
  1: [[1, 16]],
  2: [[1, 28]],
  3: [[1, 44]],
  4: [[2, 32]],
  5: [[2, 43]],
  6: [
    [2, 27],
    [2, 27],
  ],
};

const ALIGNMENT_CENTERS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};

const REMAINDER_BITS: Record<number, number> = {
  1: 0,
  2: 7,
  3: 7,
  4: 7,
  5: 7,
  6: 7,
};

function totalDataCodewords(version: number): number {
  return BLOCK_GROUPS[version].reduce((sum, [count, dcw]) => sum + count * dcw, 0);
}

// ---- Galois field GF(256), primitive polynomial 0x11D ------------------------

const GF_EXP: number[] = new Array(512);
const GF_LOG: number[] = new Array(256);
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

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed–Solomon generator polynomial of the given degree (coefficients). */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], GF_EXP[i]); // × α^i
      next[j + 1] ^= poly[j]; // × x
    }
    poly = next;
  }
  return poly;
}

/** EC bytes for one data block. */
function rsErrorCorrection(data: number[], ecLength: number): number[] {
  // gen is in ASCENDING x order (gen[0] = constant term, gen[ecLength]
  // = 1). The shift register needs the coefficients in DESCENDING
  // order without the leading 1: register cell i pairs with the
  // coefficient of x^(ecLength−1−i), i.e. gen[ecLength−1−i].
  const gen = rsGenerator(ecLength);
  const result = new Array(ecLength).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < ecLength; i++) {
      result[i] ^= gfMul(gen[ecLength - 1 - i], factor);
    }
  }
  return result;
}

// ---- Data bit stream -----------------------------------------------------------

class BitBuffer {
  bits: boolean[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push(((value >>> i) & 1) === 1);
    }
  }
  putBytes(bytes: number[]): void {
    for (const b of bytes) this.put(b, 8);
  }
}

/** Encodes the text into the final interleaved codeword byte list. */
function encodeCodewords(bytes: number[], version: number): number[] {
  const dataCapacity = totalDataCodewords(version);
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // byte mode
  buffer.put(bytes.length, 8); // char count (versions 1–9: 8 bits)
  buffer.putBytes(bytes);
  const capacityBits = dataCapacity * 8;
  // Terminator + alignment + pad bytes 0xEC / 0x11.
  const terminator = Math.min(4, capacityBits - buffer.bits.length);
  for (let i = 0; i < terminator; i++) buffer.bits.push(false);
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(false);
  const dataBytes: number[] = [];
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) if (buffer.bits[i + j]) b |= 0x80 >> j;
    dataBytes.push(b);
  }
  for (let pad = 0xec; dataBytes.length < dataCapacity; pad = pad === 0xec ? 0x11 : 0xec) {
    dataBytes.push(pad);
  }
  // Split into blocks, compute EC, interleave.
  const ecLength = EC_PER_BLOCK[version];
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [count, dcw] of BLOCK_GROUPS[version]) {
    for (let i = 0; i < count; i++) {
      const data = dataBytes.slice(offset, offset + dcw);
      offset += dcw;
      blocks.push({ data, ec: rsErrorCorrection(data, ecLength) });
    }
  }
  const result: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of blocks) result.push(block.ec[i]);
  }
  return result;
}

// ---- Matrix construction ---------------------------------------------------------

type Grid = (boolean | null)[][];

function newGrid(size: number): Grid {
  return Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
}

function drawFinder(grid: Grid, x0: number, y0: number): void {
  const size = grid.length;
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const border =
        inOuter && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
      const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      grid[y][x] = border || core;
    }
  }
}

function drawAlignment(grid: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      grid[cy + dy][cx + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
    }
  }
}

/** Function patterns + reserved format areas; data cells stay null. */
function baseMatrix(version: number): Grid {
  const size = 21 + 4 * (version - 1);
  const grid = newGrid(size);
  drawFinder(grid, 0, 0);
  drawFinder(grid, size - 7, 0);
  drawFinder(grid, 0, size - 7);
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }
  // Alignment patterns (skip overlaps with finders).
  const centers = ALIGNMENT_CENTERS[version];
  for (const cy of centers) {
    for (const cx of centers) {
      if (grid[cy][cx] !== null) continue;
      drawAlignment(grid, cx, cy);
    }
  }
  // Dark module.
  grid[size - 8][8] = true;
  // Reserve format information cells (filled per-mask later).
  const reserve = (x: number, y: number) => {
    if (grid[y][x] === null) grid[y][x] = false;
  };
  for (let i = 0; i <= 5; i++) reserve(8, i);
  reserve(8, 7);
  reserve(8, 8);
  reserve(7, 8);
  for (let i = 9; i <= 14; i++) reserve(14 - i, 8);
  for (let i = 0; i <= 7; i++) reserve(size - 1 - i, 8);
  for (let i = 8; i <= 14; i++) reserve(8, size - 15 + i);
  return grid;
}

/** Places the codeword bits (MSB first) in the standard zigzag. */
function placeData(grid: Grid, codewords: number[], version: number): void {
  const size = grid.length;
  const bits: boolean[] = [];
  for (const b of codewords) {
    for (let i = 7; i >= 0; i--) bits.push(((b >>> i) & 1) === 1);
  }
  for (let i = 0; i < REMAINDER_BITS[version]; i++) bits.push(false);
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the timing column
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (grid[y][x] === null) {
          grid[y][x] = bitIndex < bits.length ? bits[bitIndex] : false;
          bitIndex++;
        }
      }
    }
    upward = !upward;
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Applies a mask to data (non-function) cells of a fresh base+data grid. */
function applyMask(grid: Grid, functionMap: Grid, mask: number): void {
  const size = grid.length;
  const fn = MASKS[mask];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (functionMap[y][x] === null && fn(x, y)) {
        grid[y][x] = !grid[y][x];
      }
    }
  }
}

/** 15-bit format information for ECC level M (bits 00) and a mask. */
function formatBits(mask: number): number {
  const data = mask; // level M indicator bits are 00, so data = 0b00<mask>
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >> 9) * 0b10100110111);
  }
  return (((data << 10) | rem) ^ 0b101010000010010) & 0x7fff;
}

function drawFormat(grid: Grid, mask: number): void {
  const size = grid.length;
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  // First copy (top-left).
  for (let i = 0; i <= 5; i++) grid[i][8] = bit(i);
  grid[7][8] = bit(6);
  grid[8][8] = bit(7);
  grid[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) grid[8][14 - i] = bit(i);
  // Second copy (split).
  for (let i = 0; i <= 7; i++) grid[8][size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) grid[size - 15 + i][8] = bit(i);
  grid[size - 8][8] = true; // dark module
}

// ---- Penalty scoring (mask selection) -------------------------------------------

function penaltyScore(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push(m[i]);
    lines.push(m.map((row) => row[i]));
  }
  // Rule 1: runs of 5+ same-color modules.
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
  }
  // Rule 2: 2×2 same-color blocks.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      if (
        m[y][x] === m[y][x + 1] &&
        m[y][x] === m[y + 1][x] &&
        m[y][x] === m[y + 1][x + 1]
      ) {
        score += 3;
      }
    }
  }
  // Rule 3: finder-like patterns with a 4-module quiet side.
  const patternA = [false, false, false, false, true, false, true, true, true, false, true];
  const patternB = [true, false, true, true, true, false, true, false, false, false, false];
  for (const line of lines) {
    for (let i = 0; i + 11 <= size; i++) {
      const slice = line.slice(i, i + 11);
      if (
        patternA.every((v, j) => slice[j] === v) ||
        patternB.every((v, j) => slice[j] === v)
      ) {
        score += 40;
      }
    }
  }
  // Rule 4: deviation of the dark ratio from 50%.
  let dark = 0;
  for (const row of m) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  score += k * 10;
  return score;
}

// ---- Public API --------------------------------------------------------------------

/**
 * Encodes text (UTF-8, byte mode, ECC level M) into a QR matrix.
 * Returns null when the text is too long even for version 6
 * (106 bytes) — driver links are ~65 bytes, so this never fires
 * in practice.
 */
export function encodeQr(text: string): QrMatrix | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 0;
  for (let v = 1; v <= 6; v++) {
    if (4 + 8 + bytes.length * 8 <= totalDataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;
  const codewords = encodeCodewords(bytes, version);
  const functionMap = baseMatrix(version);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = baseMatrix(version);
    placeData(grid, codewords, version);
    applyMask(grid, functionMap, mask);
    drawFormat(grid, mask);
    const filled = grid.map((row) => row.map((cell) => cell === true));
    const score = penaltyScore(filled);
    if (score < bestScore) {
      bestScore = score;
      best = filled;
    }
  }
  const size = 21 + 4 * (version - 1);
  return { size, modules: best!.flat() };
}

/**
 * The module map as one row-major string of '1' (dark) / '0' (light),
 * size × size characters — the compact form sent inside print jobs
 * so the kitchen printer app can draw the code without a QR library.
 */
export function qrModuleString(qr: QrMatrix): string {
  return qr.modules.map((m) => (m ? "1" : "0")).join("");
}
