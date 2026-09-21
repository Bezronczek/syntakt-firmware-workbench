// Syntakt OS .syx codec + SY CHORD wave bank access. Pure functions, no dependencies;
// runs in browsers and in Node (ES module). Never ships or fetches firmware: every
// byte of Elektron data comes from the file the user supplies.
//
// Layers: SysEx messages -> 8-in-7 packed packets -> [size:4][checksum:4] + ELE3 container.
// Only same-size edits of a raw (uncompressed) section are supported, which is all the
// wave bank needs, so no compressor is required and every offset stays put.

export const SUPPORTED = {
  // sha256 of the official file -> description
  "8e2488f462c4a5656396a895f113bcd415e9900fa8709340dccf45d4cb9ed19e": "Syntakt OS 1.41",
};

export const WAVE = {
  SECTION_ID: 7,
  SECTION_LEN: 383760,
  SECTION_SHA256: "daf6451cf9587c0b628e901b7bb6b25f4e2633d448c534c0c181dd35ec783bc2",
  BANK_END: 0x1e3fc, // frame k (1..31) starts at BANK_END - k * STEP, i.e. stored in reverse
  STEP: 0x404,
  SAMPLES: 257, // one cycle in 256 samples + guard (y[256] == y[0])
  FRAMES: 31,
  PEAK: 0x7fff0000,
  SINE_OFF: 0x53e50, // frame 0: a sine SHARED with other machines
};

const PKT = 126, HDR = 9, ENC = 116, CK = 125, CK_FROM = 6, CK_SPAN = 119, DEC_PER_PKT = 101;

export async function sha256hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function be32(a, o) { return ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0; }
function wr32(a, o, v) { a[o] = v >>> 24; a[o + 1] = (v >>> 16) & 255; a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255; }

export function contentChecksum(container) {
  let acc = 0;
  for (let k = 0, n = container.length >>> 2; k < n; k++) acc = (acc + (((k + 1) ^ be32(container, 4 * k)) >>> 0)) >>> 0;
  return acc;
}

export function packetChecksum(body, base) {
  let acc = 0;
  for (let i = 0; i < CK_SPAN; i++) acc += body[CK_FROM + i] ^ ((base + i) & 0xff);
  return (base + acc) & 0x7f;
}

/** Split the file into SysEx messages and decode the data packets. Throws on anything unexpected. */
export function parseSyx(file) {
  const msgs = []; // {start, end} of each body (between F0 and F7)
  let i = 0;
  while (i < file.length) {
    if (file[i] !== 0xf0) throw new Error("byte " + i + ": expected F0");
    const e = file.indexOf(0xf7, i);
    if (e < 0) throw new Error("unterminated SysEx message");
    msgs.push({ start: i + 1, end: e });
    i = e + 1;
  }
  const data = msgs.filter((m) => m.end - m.start === PKT && file[m.start + 5] === 0x7e);
  const markers = msgs.filter((m) => file[m.start + 5] === 0x7f);
  if (markers.length !== 2 || data.length + 2 !== msgs.length) throw new Error("unexpected message layout");
  const base = file[markers[0].start + 7];
  const decoded = new Uint8Array(data.length * DEC_PER_PKT);
  let o = 0;
  for (const m of data) {
    const body = file.subarray(m.start, m.end);
    if (packetChecksum(body, base) !== body[CK]) throw new Error("packet checksum mismatch: damaged file");
    for (let k = HDR; k < HDR + ENC; k += 8) {
      const ms = body[k], nd = Math.min(7, HDR + ENC - k - 1);
      for (let n = 0; n < nd; n++) decoded[o++] = body[k + 1 + n] | (((ms >> (6 - n)) & 1) << 7);
    }
  }
  const size = be32(decoded, 0);
  if (size + 8 > decoded.length) throw new Error("declared container size exceeds the data");
  const container = decoded.subarray(8, 8 + size);
  if (String.fromCharCode(...container.subarray(0, 4)) !== "ELE3") throw new Error("not an ELE3 container");
  if (contentChecksum(container) !== be32(decoded, 4)) throw new Error("container checksum mismatch");
  const sections = [];
  for (let s = 0, n = be32(container, 0x1c); s < n; s++) {
    const t = 0x20 + 16 * s;
    sections.push({ id: be32(container, t), offset: be32(container, t + 4), length: be32(container, t + 8), dest: be32(container, t + 12) });
  }
  return { file, data, base, decoded, container, sections, version: String.fromCharCode(...container.subarray(0x14, 0x18)) };
}

export function getSection(parsed, id) {
  const s = parsed.sections.find((x) => x.id === id);
  if (!s) throw new Error("no section " + id);
  return parsed.container.slice(s.offset, s.offset + s.length);
}

/** Return a new .syx with raw section `id` replaced by same-length `bytes`; all checksums recomputed. */
export function replaceRawSection(parsed, id, bytes) {
  const s = parsed.sections.find((x) => x.id === id);
  if (!s || bytes.length !== s.length) throw new Error("replacement must have exactly the size of the section");
  const decoded = parsed.decoded.slice();
  decoded.set(bytes, 8 + s.offset);
  wr32(decoded, 4, contentChecksum(decoded.subarray(8, 8 + be32(decoded, 0))));
  const out = parsed.file.slice();
  let o = 0;
  for (const m of parsed.data) {
    const body = out.subarray(m.start, m.end);
    for (let k = HDR; k < HDR + ENC; k += 8) {
      const nd = Math.min(7, HDR + ENC - k - 1);
      let ms = 0;
      for (let n = 0; n < nd; n++) { const v = decoded[o++]; if (v & 0x80) ms |= 1 << (6 - n); body[k + 1 + n] = v & 0x7f; }
      body[k] = ms;
    }
    body[CK] = packetChecksum(body, parsed.base);
  }
  return out;
}

// ---- SY CHORD wave bank -------------------------------------------------------------

export function frameOffset(k) {
  if (k === 0) return WAVE.SINE_OFF;
  if (k < 1 || k > WAVE.FRAMES) throw new Error("frame must be 0..31");
  return WAVE.BANK_END - k * WAVE.STEP;
}

/** Frame k of a section-7 image as Float64Array(256) in -1..1 (guard sample dropped). */
export function readFrame(section, k) {
  const v = new DataView(section.buffer, section.byteOffset + frameOffset(k), WAVE.SAMPLES * 4);
  const y = new Float64Array(256);
  for (let i = 0; i < 256; i++) y[i] = v.getInt32(4 * i) / 2147483648;
  return y;
}

/** Write a 256-sample cycle (floats, any scale) as frame k: DC removed, peak-normalised, y[0] = 0, guard added.
 *  The caller is responsible for phase (the cycle should start at a rising zero crossing) and band-limiting. */
export function writeFrame(section, k, cycle) {
  if (cycle.length !== 256) throw new Error("cycle must have 256 samples");
  let mean = 0; for (const x of cycle) mean += x; mean /= 256;
  let peak = 0; for (const x of cycle) peak = Math.max(peak, Math.abs(x - mean));
  if (!(peak > 0)) throw new Error("silent cycle");
  const v = new DataView(section.buffer, section.byteOffset + frameOffset(k), WAVE.SAMPLES * 4);
  for (let i = 0; i < 256; i++) v.setInt32(4 * i, i === 0 ? 0 : Math.round(((cycle[i] - mean) / peak) * WAVE.PEAK));
  v.setInt32(4 * 256, 0);
}

/** Byte range in which `b` differs from `a`, as [first, last], or null: used by the self-check. */
export function diffRange(a, b) {
  if (a.length !== b.length) return [0, Math.max(a.length, b.length) - 1];
  let first = -1, last = -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (first < 0) first = i; last = i; }
  return first < 0 ? null : [first, last];
}
