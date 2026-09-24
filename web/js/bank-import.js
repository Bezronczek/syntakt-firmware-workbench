// Importing a whole bank of waves at once: a WaftWave bank (.json) or a ZIP of WAV files.
// Pure functions, no DOM: runs in a browser and in Node (ES module). The tool view decides
// where the waves go; this module only turns a file into a list of named cycles.
//
// WaftWave (wftlrd.uk/waftwave) edits Machinedrum / Monomachine DigiPRO waves. Its bank export
// is JSON: { format: "mmdt-digipro-bank", version, count, waves: [{ slot, name, data }] },
// up to 64 waves of 96 unsigned 8-bit samples, 128 = silence. Older files carry `dataU8`
// instead of `data`. Its "Export bank WAVs" gives a ZIP of single-cycle WAVs.

import { decodeWav } from "./wave-dsp.js";

export const WAFT_FORMAT = "mmdt-digipro-bank";
export const WAFT_SLOTS = 64;

/**
 * Parse a WaftWave bank. Waves come back in slot order, each as a float cycle in -1..+1.
 * @param {string|ArrayBuffer|Uint8Array} input the file contents
 * @returns {{slot:number, name:string, samples:Float64Array}[]}
 */
export function parseWaftBank(input) {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("this JSON file could not be read");
  }
  if (!obj || obj.format !== WAFT_FORMAT || !Array.isArray(obj.waves)) {
    throw new Error("this is not a WaftWave bank (expected format " + WAFT_FORMAT + ")");
  }
  const out = [];
  const seen = new Set();
  for (const rec of obj.waves) {
    if (!rec) continue;
    const slot = Number(rec.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= WAFT_SLOTS || seen.has(slot)) continue;
    const data = Array.isArray(rec.data) && rec.data.length ? rec.data
      : rec.dataU8 && rec.dataU8.length ? Array.from(rec.dataU8) : null;
    if (!data || data.length < 8) continue;
    const samples = Float64Array.from(data, (x) => (Math.max(0, Math.min(255, Number(x) | 0)) - 128) / 128);
    let lo = Infinity, hi = -Infinity;
    for (const x of samples) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    if (hi - lo <= 0) continue; // an empty slot is silence; skip it rather than fail the bank
    seen.add(slot);
    const name = String(rec.name || "WAVE").trim() || "WAVE";
    out.push({ slot, name: "WaftWave " + String(slot + 1).padStart(2, "0") + " " + name, samples });
  }
  if (!out.length) throw new Error("this WaftWave bank has no waves in it");
  return out.sort((a, b) => a.slot - b.slot);
}

/**
 * Pick `room` of `count` items, spread evenly from the first to the last, so a 64-wave bank
 * keeps its whole sweep in 31 waves. Returns indices, ascending, without repeats.
 */
export function spreadIndices(count, room) {
  if (count <= room) return Array.from({ length: count }, (_, i) => i);
  if (room <= 1) return room === 1 ? [0] : [];
  return Array.from({ length: room }, (_, i) => Math.round((i * (count - 1)) / (room - 1)));
}

// ---- ZIP ---------------------------------------------------------------------------------

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") throw new Error("this browser cannot open ZIP files");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The files inside a ZIP, read through its central directory. Folders are skipped;
 * `wanted(name)` filters before anything is decompressed.
 * @returns {Promise<{name:string, bytes:Uint8Array}[]>}
 */
export async function readZip(input, wanted = () => true) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 0xffff); p--) {
    if (view.getUint32(p, true) === EOCD) { end = p; break; }
  }
  if (end < 0) throw new Error("this is not a ZIP file");
  const entries = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < entries; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) throw new Error("this ZIP file is damaged");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || !wanted(name)) continue;
    if (flags & 1) throw new Error("this ZIP file is password protected");
    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL) throw new Error("this ZIP file is damaged");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = bytes.subarray(start, start + size);
    if (method === 0) out.push({ name, bytes: packed.slice() });
    else if (method === 8) out.push({ name, bytes: await inflateRaw(packed) });
    else throw new Error("this ZIP file uses a compression this page cannot read");
  }
  return out;
}

const baseName = (path) => path.split("/").pop();

/**
 * The single-cycle WAVs in a ZIP, in name order (WaftWave numbers them MM-WAVE-01-...).
 * Files that are not WAVs, macOS resource forks and WAVs that do not decode are skipped
 * and counted, so the caller can say so.
 * @returns {Promise<{waves:{name:string, samples:Float64Array}[], skipped:number}>}
 */
export async function wavsFromZip(input) {
  const files = await readZip(input, (n) => /\.wav$/i.test(n) && !n.startsWith("__MACOSX/") && !baseName(n).startsWith("._"));
  files.sort((a, b) => baseName(a.name).localeCompare(baseName(b.name)));
  const waves = [];
  let skipped = 0;
  for (const f of files) {
    try {
      waves.push({ name: baseName(f.name), samples: decodeWav(f.bytes).samples });
    } catch {
      skipped++;
    }
  }
  if (!waves.length) throw new Error("there are no WAV files in this ZIP that this page can read");
  return { waves, skipped };
}
