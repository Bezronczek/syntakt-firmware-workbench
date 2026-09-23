// DV LFO shapes: two "deja vu" random loopers added to the LFO WAVE list of Syntakt OS 1.41, after the
// seven built-in shapes: DV-F (runs free) and DV-T (every note restarts the loop).
//   SPH  = deja vu: 0 new values all the time, 64 the loop repeats, 127 the same values in a new order.
//   MODE = loop length: 2, 4, 8, 16 or 32 steps; the MODE cell shows that number for a DV shape.
// Built and checked on a real Syntakt on 23 September 2026.
//
// Everything here works on the raw (decompressed) MAIN OS section, section 3. The patch writes our own
// machine code and data into two runs of the section that are blank in the official file, and changes a
// few operands and constants in place. It never writes firmware bytes taken from this file into the page:
// what it needs from the firmware (built-in tables it extends) it copies from the section it is given.
// DOM free, so the Node tests drive it.

export const SECTION = 3;
export const BASE = 0x40000400;                     // address of byte 0 of the raw section
const off = (va) => va - BASE;
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

export const DVF = 7, DVT = 8, N = 9, LAST = N - 1;   // WAVE values of the new shapes, shape count
export const NAMES = ["DV-F", "DV-T"];

const CAVE = 0x402ba000, CAVE_LEN = 0x1780;         // blank in the official file
const CAVE2 = 0x402b9b00, CAVE2_LEN = 0x500;        // blank in the official file
const L = {
  GEN: 0x000, NAMES: 0x040, STRINGS: 0x080, MARK: 0x0a0,
  START0: 0x0c0, START1: 0x100, START2: 0x140, FLAGS: 0x180,
  SHEET_VEC: 0x1a0, SHEET_OBJS: 0x1b0, GLYPH_DV: 0x300, SET_ARR: 0x3a0,
  SET_OBJS_DVF: 0x440, SET_OBJS_DVT: 0x4b0, MASTER_DVF: 0x520, MASTER_DVT: 0x590, LIVE_DVF: 0x600, LIVE_DVT: 0x670,
  PROB: 0x6e0, SLIDE2: 0x700, MODEHELP: 0x740, LASTWAVE: 0x760, LENSTR: 0x770, LENTAB: 0x780,
  HOOK1: 0x7a0, HOOK2: 0x7c0, CODE_DVF: 0x920, CODE_DVT: 0xb40, SLOTS: 0xd80,
};
const L2 = { ICONVEC: 0x00, ICONHELP: 0x10, ICONOBJS: 0x30, ICONDATA: 0xc0 };

// Firmware addresses this patch reads or changes (OS 1.41).
const GEN_TABLE = 0x40245838, NAME_TABLE = 0x401d44c4, FLAG_TABLE = 0x4023ff00;
const START_TABLES = [0x402457e4, 0x40245800, 0x4024581c];
const BITMAP_VPTR = 0x40240c3c, GLYPH_BLOCKS = 0x4031b858, GLYPH_MASK = 0x4031b80c, GLYPH_STRIDE = 0x4c;
const TILE_MASK = 0x402d7e1c, TILE_EXTRA = 0x00ffffff, MODE_ICON_MASK = 0x40304cec;
const MODE_NAMES = 0x401d44e0, SHEET_GET = 0x400f9258, NO_SLIDE_RETURN = 0x400f32ec;
const OPERAND_SITES = [                             // [address of the instruction, what its 32-bit operand now points at]
  [0x40119154, CAVE + L.GEN], [0x40119460, CAVE + L.GEN],
  [0x400702e4, CAVE + L.SHEET_VEC], [0x4014f82c, CAVE + L.SHEET_VEC],
  [0x400f32f2, CAVE + L.FLAGS],
  ...[0x400f339c, 0x400f33b0, 0x400f33be, 0x400f33cc, 0x400f33de, 0x400f33ec, 0x400f33fa].map((a, k) => [a, CAVE + L.SET_ARR + 12 * k]),
  [0x400f3420, CAVE + L.SET_ARR], [0x400f347c, CAVE + L.SET_ARR],
  [0x40070338, CAVE2 + L2.ICONHELP],
  [0x40119032, CAVE + L.START0], [0x4011934e, CAVE + L.START0],
  [0x40119068, CAVE + L.START1], [0x4011937e, CAVE + L.START1],
  [0x4011905c, CAVE + L.START2], [0x40119374, CAVE + L.START2],
];
const COUNT_BYTES = [                               // [address, value]: shape counts and last-shape limits
  [0x400f323b, LAST], [0x400f325d, LAST], [0x400f32f1, N], [0x400f32fb, 0x100 - N], [0x400f3307, 0x100 - N],
  [0x40118ffd, LAST], [0x40119003, LAST], [0x401192eb, LAST], [0x401192f1, LAST], [0x4006fa9f, LAST],
];
const WAVE_MAX = [0x4022e7f0, 0x4022e9f8];          // longs: the WAVE parameter's maximum, LFO1 and LFO2
const WIDGET = 0x400f32c0;                          // 22 bytes: four instructions move up 2 bytes, then a call
const NAME_FORMATTERS = [[0x4006fab2, CAVE + L.NAMES, "lea"], [0x4006fb26, CAVE + L.MODEHELP, "jsr"]];   // 28 bytes each
const EVAL_HOOKS = [[0x40118fe2, 8, CAVE + L.HOOK1, 7], [0x40119312, 6, CAVE + L.HOOK2, 1]];   // [site, length, hook, mode register]

/** Byte ranges [start, end) of section 3 this patch may change. Deliberately coarse: every site is covered
 *  by a span of the surrounding code or data, so the published fingerprints (a digest per region) never
 *  describe only a few bytes of the official file. */
export const REGIONS = [
  [CAVE2, CAVE2 + CAVE2_LEN, "MODE cell pictures for the DV shapes"],
  [CAVE, CAVE + CAVE_LEN, "DV shapes: code, names and pictures"],
  [0x4006fa9e, 0x4006fb42, "shape and MODE names"],
  [0x400702e0, 0x40070340, "shape pictures, MODE cell"],
  [0x400f3238, 0x400f3482, "WAVE picture"],
  [0x4014f820, 0x4014f840, "shape pictures"],
  [0x40118fe0, 0x40119160, "LFO shapes (1)"],
  [0x401192e8, 0x40119468, "LFO shapes (2)"],
  [0x4022e7e4, 0x4022e818, "WAVE range, LFO 1"],
  [0x4022e9ec, 0x4022ea20, "WAVE range, LFO 2"],
].map(([s0, e0, label]) => ({ start: off(s0), end: off(e0), label })).sort((a, b) => a.start - b.start);

// ---- a tiny assembler: byte arrays, labels, 16-bit branches -----------------------------

const label = (l) => ({ label: l });
const br = (op, to) => ({ br: op, to });
const BEQ = 0x6700, BNE = 0x6600, BCC = 0x6400, BCS = 0x6500, BRA = 0x6000, BLS = 0x6300;
function assemble(items) {
  const out = [], labels = {}, fixups = [];
  for (const it of items) {
    if (it.label) labels[it.label] = out.length;
    else if (it.br) { fixups.push({ at: out.length, to: it.to }); out.push((it.br >> 8) & 255, it.br & 255, 0, 0); }
    else out.push(...it);
  }
  for (const f of fixups) {
    const disp = labels[f.to] - (f.at + 2);
    if (!(f.to in labels) || disp < -32768 || disp > 32767 || disp === 0) throw new Error("bad branch to " + f.to);
    out[f.at + 2] = (disp >> 8) & 255; out[f.at + 3] = disp & 255;
  }
  return out;
}

/** xorshift32 on the long at `seed` -> d0 (clobbers d1). */
const xorshift = (seed) => [
  0x20, 0x39, ...be32(seed), 0x66, 0x00, 0x00, 0x08, 0x20, 0x3c, 0x2f, 0x6e, 0x2b, 0x1d,
  0x22, 0x00, 0xe1, 0x89, 0xeb, 0x89, 0xb3, 0x80,
  0x22, 0x00, 0xe0, 0x89, 0xe0, 0x89, 0xe2, 0x89, 0xb3, 0x80,
  0x22, 0x00, 0xeb, 0x89, 0xb3, 0x80,
  0x23, 0xc0, ...be32(seed),
];

/** The shape generator: phase at 4(a7), level in d0 (bipolar), a2 = the LFO's state, a3 = its parameters
 *  (SPH word at 4, MODE byte at 6). 16 steps per LFO cycle; a loop of 2 << MODE random values per LFO,
 *  kept in a 80-byte slot picked from a2. trig: restart the loop when the LFO was retriggered. */
export function generatorCode({ slots, seed, trig }) {
  const RANDOM = xorshift(seed);
  const TOPBYTE = [0x22, 0x00, 0xe0, 0x89, 0xe0, 0x89, 0xe0, 0x89];
  return assemble([
    [0x4f, 0xef, 0xff, 0xf4], [0x48, 0xd7, 0x00, 0x1c], [0x20, 0x2f, 0x00, 0x10], [0x72, 0x1c], [0xe2, 0xa8],
    [0x22, 0x0a], [0xe6, 0x89], [0x02, 0x81, 0x00, 0x00, 0xff, 0xff], [0x24, 0x3c, 0x00, 0x00, 0xcc, 0xcd],
    [0x4c, 0x02, 0x10, 0x00], [0x74, 0x12], [0xe4, 0xa9], [0x02, 0x81, 0x00, 0x00, 0x00, 0x1f],
    [0x24, 0x01], [0xed, 0x89], [0xe9, 0x8a], [0xd2, 0x82],
    [0x41, 0xf9, ...be32(slots)], [0xd1, 0xc1],
    [0x22, 0x0a], [0xb2, 0xa8, 0x00, 0x0c], br(BEQ, "owned"), [0x42, 0x90], [0x21, 0x41, 0x00, 0x0c],
    label("owned"),
    [0x24, 0x00], [0x52, 0x82], [0x26, 0x10], br(BEQ, "fresh"),
    ...(trig ? [[0x4a, 0x2a, 0x00, 0x01], br(BEQ, "notrig"), [0x42, 0xa8, 0x00, 0x04], [0x20, 0x82], br(BRA, "out"), label("notrig")] : []),
    [0xb4, 0x83], br(BEQ, "out"),
    [0x53, 0x83], [0x22, 0x00], [0x92, 0x83], [0x02, 0x81, 0x00, 0x00, 0x00, 0x0f], [0x0c, 0x81, 0x00, 0x00, 0x00, 0x0f],
    br(BEQ, "out"), br(BRA, "step"),
    label("fresh"),
    [0x43, 0xe8, 0x00, 0x10], [0x76, 0x20],
    label("fill"), RANDOM, [0x12, 0xc0], [0x53, 0x83], br(BNE, "fill"),
    [0x42, 0xa8, 0x00, 0x04], [0x42, 0xa8, 0x00, 0x30],
    label("step"),
    [0x20, 0x82], [0x24, 0x28, 0x00, 0x04],
    [0x38, 0x2b, 0x00, 0x04], [0x02, 0x84, 0x00, 0x00, 0xff, 0xff], [0xe0, 0x8c], [0x02, 0x84, 0x00, 0x00, 0x00, 0x7f],
    [0x76, 0x00], [0x16, 0x2b, 0x00, 0x06], [0x0c, 0x83, 0x00, 0x00, 0x00, 0x04], br(BLS, "lenok"), [0x76, 0x04],
    label("lenok"),
    [0x72, 0x02], [0xe7, 0xa9], [0x26, 0x01],
    [0x52, 0x82], [0xb4, 0x83], br(BCS, "nowrap"), [0x42, 0x82],
    label("nowrap"),
    [0x0c, 0x84, 0x00, 0x00, 0x00, 0x40], br(BCS, "replace"),
    [0x04, 0x84, 0x00, 0x00, 0x00, 0x40], [0xe5, 0x8c], RANDOM, TOPBYTE, [0xb2, 0x84], br(BCC, "store"),
    [0xe0, 0x88, 0xe0, 0x88], [0x02, 0x80, 0x00, 0x00, 0x00, 0xff], [0x4c, 0x03, 0x00, 0x00], [0xe0, 0x88], [0x24, 0x00],
    br(BRA, "store"),
    label("replace"),
    [0x72, 0x3f], [0x92, 0x84], [0xe5, 0x89], [0x28, 0x01], RANDOM, TOPBYTE, [0xb2, 0x84], br(BCC, "store"),
    [0xe0, 0x88, 0xe0, 0x88], [0x11, 0x80, 0x28, 0x10],
    label("store"),
    [0x21, 0x42, 0x00, 0x04],
    label("out"),
    [0x24, 0x28, 0x00, 0x04], [0x10, 0x30, 0x28, 0x10], [0x02, 0x80, 0x00, 0x00, 0x00, 0xff],
    [0x04, 0x80, 0x00, 0x00, 0x00, 0x80], [0x72, 0x18], [0xe3, 0xa8],
    [0x4c, 0xd7, 0x00, 0x1c], [0x4f, 0xef, 0x00, 0x0c], [0x4e, 0x75],
  ]);
}

/** Runs where the LFO's mode is read: first the instructions it replaces (`head`, copied from the section
 *  being patched), then FREE for DV-F and TRIG for DV-T in the register that holds the mode. */
function modeHookCode(head, reg) {
  const moveq = (v) => [0x70 | (reg << 1), v];
  return [...head,
    0x0c, 0x83, 0x00, 0x00, 0x00, DVF, 0x66, 0x04, ...moveq(0), 0x4e, 0x75,
    0x0c, 0x83, 0x00, 0x00, 0x00, DVT, 0x66, 0x02, ...moveq(1), 0x4e, 0x75];
}

// ---- pictures ------------------------------------------------------------------------

function stepTile(levels, widths, wrap) {         // 28 x 15, one long per column, stored upside down
  const edges = [0]; for (const w of widths) edges.push(edges[edges.length - 1] + w);
  const words = [];
  for (let x = 0; x < 28; x++) {
    const k = edges.filter((e) => e <= x).length - 1;
    const ys = new Set([levels[k]]);
    const span = (a, b) => { for (let y = Math.min(a, b); y <= Math.max(a, b); y++) ys.add(y); };
    if (x === 0 && wrap === true) span(0, 14);
    else if (x === 0 && wrap === "closed") span(levels[levels.length - 1], levels[0]);
    else if (x > 0 && edges.includes(x)) span(levels[k - 1], levels[k]);
    let w = 0;
    for (const y of ys) w |= 0x80000000 >>> (14 - y);
    words.push(w >>> 0);
  }
  return words;
}
const LEVELS = [3, 11, 6, 13, 1, 9, 4, 12], WIDTHS = [4, 3, 4, 3, 4, 3, 4, 3];
const DV_GLYPH = [
  "..###############..", ".#...............#.", ".#...............#.", ".#...............#.", ".#...............#.",
  ".#.....##........#.", ".#.....##..##....#.", ".#.##..##..##....#.", ".#.##..##..##.##.#.", ".#.##..##..##.##.#.",
  ".#.##.###.###.##.#.", ".#.#############.#.", ".#...............#.", ".#...............#.", ".#...............#.",
  ".#...............#.", "..###############..",
];
const DIGITS = {
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  6: [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
};
export const LENGTHS = ["2", "4", "8", "16", "32"];

// ---- the patch -------------------------------------------------------------------------

/** A patched copy of the raw section 3 (`raw` = the official bytes in every region above). */
export function buildSection(raw) {
  const out = raw.slice();
  const cave = new Uint8Array(CAVE_LEN), cave2 = new Uint8Array(CAVE2_LEN);
  const put = (o, bytes) => cave.set(bytes, o), put2 = (o, bytes) => cave2.set(bytes, o);
  const from = (va, n) => raw.subarray(off(va), off(va) + n);
  const code = {
    "DV-F": generatorCode({ slots: CAVE + L.SLOTS, seed: CAVE + L.PROB + 4, trig: false }),
    "DV-T": generatorCode({ slots: CAVE + L.SLOTS, seed: CAVE + L.PROB + 4, trig: true }),
  };
  if (L.CODE_DVF + code["DV-F"].length > L.CODE_DVT || L.CODE_DVT + code["DV-T"].length > L.SLOTS) throw new Error("layout");

  // shape table, names, the tables the firmware keeps per shape
  put(L.GEN, from(GEN_TABLE, 28));
  put(L.GEN + 4 * DVF, be32(CAVE + L.CODE_DVF));
  put(L.GEN + 4 * DVT, be32(CAVE + L.CODE_DVT));
  put(L.NAMES, from(NAME_TABLE, 28));
  NAMES.forEach((name, i) => {
    put(L.NAMES + 4 * (7 + i), be32(CAVE + L.STRINGS + 8 * i));
    put(L.STRINGS + 8 * i, [...name].map((c) => c.charCodeAt(0)));
  });
  put(L.MARK, [..."LFO9 DV-F/DV-T preview 2026-09-23"].map((c) => c.charCodeAt(0)));
  put(L.CODE_DVF, code["DV-F"]);
  put(L.CODE_DVT, code["DV-T"]);
  for (const [a, n, hook, reg] of EVAL_HOOKS) put(hook - CAVE, modeHookCode(from(a, n), reg));
  START_TABLES.forEach((t, k) => put([L.START0, L.START1, L.START2][k], from(t, 28)));
  put(L.FLAGS, [...from(FLAG_TABLE, 7), 1, 1]);

  // the 19x17 shape pictures of the other LFO view
  put(L.SHEET_VEC, [...be32(CAVE + L.SHEET_OBJS), ...be32(CAVE + L.SHEET_OBJS + N * 0x1c), ...be32(CAVE + L.SHEET_OBJS + N * 0x1c)]);
  for (let k = 0; k < N; k++) {
    const data = k < 7 ? GLYPH_BLOCKS + k * GLYPH_STRIDE : CAVE + L.GLYPH_DV;
    put(L.SHEET_OBJS + k * 0x1c, [...be32(BITMAP_VPTR), ...be32(0x13), ...be32(0x11), ...be32(1), ...be32(data), ...be32(GLYPH_MASK), ...be32(0)]);
  }
  for (let c = 0; c < 19; c++) {
    let w = 0;
    for (let y = 0; y < 17; y++) if (DV_GLYPH[y][c] === "#") w |= 0x80000000 >>> y;
    put(L.GLYPH_DV + 4 * c, be32(w >>> 0));
  }

  // the WAVE cell pictures
  const sets = { "DV-F": [L.SET_OBJS_DVF, L.LIVE_DVF, L.MASTER_DVF, "closed"], "DV-T": [L.SET_OBJS_DVT, L.LIVE_DVT, L.MASTER_DVT, true] };
  NAMES.forEach((name, i) => {
    const [objs, live, master, wrap] = sets[name];
    put(L.SET_ARR + 12 * (7 + i), [...be32(CAVE + objs), ...be32(CAVE + objs + 4 * 0x1c), ...be32(CAVE + objs + 4 * 0x1c)]);
    for (let v = 0; v < 4; v++)
      put(objs + v * 0x1c, [...be32(BITMAP_VPTR), ...be32(28), ...be32(15), ...be32(1), ...be32(CAVE + live), ...be32(TILE_MASK), ...be32(TILE_EXTRA)]);
    stepTile(LEVELS, WIDTHS, wrap).forEach((w, c) => { put(master + 4 * c, be32(w)); put(live + 4 * c, be32(w)); });
  });
  put(L.SLIDE2, [
    0x23, 0xc5, ...be32(CAVE + L.LASTWAVE), 0x4e, 0x71, 0x4e, 0x71, 0x4e, 0x71,
    0x0c, 0x85, 0x00, 0x00, 0x00, 0x06, 0x6d, 0x06, 0x2e, 0xbc, ...be32(NO_SLIDE_RETURN), 0x4e, 0x75,
  ]);

  // MODE cell: names and pictures of the loop lengths for a DV shape
  LENGTHS.forEach((t, i) => {
    put(L.LENSTR + 3 * i, [...t].map((c) => c.charCodeAt(0)));
    put(L.LENTAB + 4 * i, be32(CAVE + L.LENSTR + 3 * i));
  });
  put(L.MODEHELP, [
    0x41, 0xf9, ...be32(MODE_NAMES), 0x20, 0x39, ...be32(CAVE + L.LASTWAVE), 0x5f, 0x80,
    0x0c, 0x80, 0x00, 0x00, 0x00, 0x01, 0x62, 0x06, 0x41, 0xf9, ...be32(CAVE + L.LENTAB), 0x4e, 0x75,
  ]);
  LENGTHS.forEach((txt, k) => {
    const g = Array.from({ length: 17 }, () => Array(19).fill("."));
    for (let x = 2; x <= 16; x++) { g[0][x] = "#"; g[16][x] = "#"; }
    for (let y = 1; y <= 15; y++) { g[y][1] = "#"; g[y][17] = "#"; }
    const x0 = txt.length === 1 ? 7 : 4;
    [...txt].forEach((ch, j) => DIGITS[ch].forEach((row, r) => [...row].forEach((c, cx) => { if (c === "#") g[5 + r][x0 + 6 * j + cx] = "#"; })));
    for (let x = 0; x < 19; x++) {
      let w = 0;
      for (let y = 0; y < 17; y++) if (g[y][x] === "#") w |= 0x80000000 >>> (16 - y);
      put2(L2.ICONDATA + k * 0x4c + 4 * x, be32(w >>> 0));
    }
    put2(L2.ICONOBJS + k * 0x1c, [...be32(BITMAP_VPTR), ...be32(0x13), ...be32(0x11), ...be32(1), ...be32(CAVE2 + L2.ICONDATA + k * 0x4c),
                                   ...be32(MODE_ICON_MASK), ...be32(0)]);
  });
  put2(L2.ICONVEC, [...be32(CAVE2 + L2.ICONOBJS), ...be32(CAVE2 + L2.ICONOBJS + 5 * 0x1c), ...be32(CAVE2 + L2.ICONOBJS + 5 * 0x1c)]);
  put2(L2.ICONHELP, [
    0x22, 0x39, ...be32(CAVE + L.LASTWAVE), 0x5f, 0x81, 0x0c, 0x81, 0x00, 0x00, 0x00, 0x01, 0x62, 0x0a,
    0x22, 0x3c, ...be32(CAVE2 + L2.ICONVEC), 0x2f, 0x41, 0x00, 0x04, 0x4e, 0xf9, ...be32(SHEET_GET),
  ]);

  // write
  out.set(cave, off(CAVE));
  out.set(cave2, off(CAVE2));
  for (const [a, target] of OPERAND_SITES) out.set(be32(target), off(a) + 2);
  for (const [a, v] of COUNT_BYTES) out[off(a)] = v;
  for (const a of WAVE_MAX) out.set(be32(LAST << 8), off(a));
  out.copyWithin(off(WIDGET), off(WIDGET) + 2, off(WIDGET) + 18);
  out.set([0x4e, 0xb9, ...be32(CAVE + L.SLIDE2)], off(WIDGET) + 16);
  for (const [a, target, kind] of NAME_FORMATTERS)
    out.set([...(kind === "lea" ? [0x41, 0xf9] : [0x4e, 0xb9]), ...be32(target), 0x41, 0xf0, 0x2c, 0x00, ...Array(9).fill([0x4e, 0x71]).flat()], off(a));
  for (const [a, n, target] of EVAL_HOOKS) out.set([0x4e, 0xb9, ...be32(target), ...(n === 8 ? [0x4e, 0x71] : [])], off(a));
  return out;
}

/** True when the section already carries this patch (its shape names are in place). */
export function isPatched(raw) {
  const o = off(CAVE + L.STRINGS);
  return String.fromCharCode(...raw.subarray(o, o + 4)) === "DV-F";
}
