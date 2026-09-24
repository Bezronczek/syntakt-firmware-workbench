// Tests for js/chord-waves.js and js/bank-import.js. No firmware and no files needed:
// every bank and ZIP used here is built in memory. Run from the project root:
//   node web/test/chord-bank.test.mjs
import * as chords from "../js/chord-waves.js";
import * as imp from "../js/bank-import.js";
import * as bank from "../js/bank.js";
import { conditionCycle, harmonicMagnitudes, encodeWavFloat32 } from "../js/wave-dsp.js";

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
  if (!cond) fails++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const rejects = async (p) => { try { await p; return false; } catch { return true; } };

// ---- chord harmonics ----------------------------------------------------------------------

ok("major, octave tuning: 16 20 24", same(chords.chordHarmonics("maj").harmonics, [16, 20, 24]));
ok("minor, octave tuning: third rounded to 19", same(chords.chordHarmonics("min").harmonics, [16, 19, 24]));
ok("minor, just tuning: 10 12 15", same(chords.chordHarmonics("min", 0, "just").harmonics, [10, 12, 15]));
ok("major 7, just tuning: 8 10 12 15", same(chords.chordHarmonics("maj7", 0, "just").harmonics, [8, 10, 12, 15]));
ok("dominant 7, just tuning: 4 5 6 7", same(chords.chordHarmonics("7", 0, "just").harmonics, [4, 5, 6, 7]));
ok("major, 1st inversion: root up an octave", same(chords.chordHarmonics("maj", 1).harmonics, [20, 24, 32]));
ok("major, 2nd inversion", same(chords.chordHarmonics("maj", 2).harmonics, [24, 32, 40]));
ok("inverted root harmonic is reported", chords.chordHarmonics("maj", 1).rootHarmonic === 32);
ok("octave tuning keeps the root on an octave for every chord",
  chords.CHORDS.every((c) => Number.isInteger(Math.log2(chords.chordHarmonics(c.id).rootHarmonic))));
ok("just tuning is exact", chords.CHORDS.every((c) => chords.chordHarmonics(c.id, 0, "just").worstCents < 1e-9));
ok("octave tuning is within 30 cents of just",
  chords.CHORDS.every((c) => chords.chordHarmonics(c.id).worstCents < 30),
  chords.CHORDS.map((c) => c.id + ":" + chords.chordHarmonics(c.id).worstCents.toFixed(1)).join(" "));
ok("power chord has no inversions", chords.inversionCount(chords.chordById("pow")) === 0);
ok("minor 9 has four inversions", chords.inversionCount(chords.chordById("m9")) === 4);
ok("an inversion that does not exist throws", throws(() => chords.chordHarmonics("maj", 3)));
ok("an unknown chord throws", throws(() => chords.chordHarmonics("nope")));
ok("an unknown tuning throws", throws(() => chords.chordHarmonics("maj", 0, "pythagorean")));

let top = 0;
for (const c of chords.CHORDS) {
  for (const t of chords.TUNINGS) {
    for (let i = 0; i <= chords.inversionCount(c); i++) top = Math.max(top, chords.chordCycle(c.id, i, t).topHarmonic);
  }
}
ok("every chord, tuning and inversion fits under harmonic 127", top <= 127, "top " + top);

ok("names read well", chords.chordName("m7", 2) === "Minor 7 chord, 2nd inversion" &&
  chords.chordName("maj", 0, "just") === "Major chord, just");
ok("harmonic 16 is four octaves up", chords.semitonesAbove(16) === 48);

// ---- chord cycles survive conditioning with exactly their tones --------------------------

{
  const c = chords.chordCycle("m9", 2);
  const { cycle } = conditionCycle(c.samples, { harmonics: c.topHarmonic });
  const mags = harmonicMagnitudes(cycle, 127);
  const peak = Math.max(...mags);
  const present = [];
  for (let n = 1; n <= 127; n++) if (mags[n] > 0.01 * peak) present.push(n);
  ok("conditioned minor 9 (2nd inv.) holds exactly its tones", same(present, c.harmonics), present.join(","));
  const levels = c.harmonics.map((h) => mags[h] / peak);
  ok("its tones are equal in level", levels.every((x) => x > 0.99), levels.join(","));
  const crestOf = (xs) => {
    let peak = 0, rms = 0;
    for (const x of xs) { peak = Math.max(peak, Math.abs(x)); rms += x * x; }
    return peak / Math.sqrt(rms / xs.length);
  };
  const zeroPhase = Float64Array.from({ length: 1024 }, (_, i) =>
    c.harmonics.reduce((y, h) => y + Math.sin((2 * Math.PI * h * i) / 1024), 0));
  ok("chosen phases peak lower than zero phases", crestOf(c.samples) < 0.8 * crestOf(zeroPhase),
    crestOf(c.samples).toFixed(2) + " vs " + crestOf(zeroPhase).toFixed(2));
}
{
  const c = chords.chordCycle("maj");
  const op = bank.makeOp(5, "replace", c.name, c.samples, Math.max(c.topHarmonic, 40));
  ok("a chord goes through the bank like a WAV does", bank.opEntry(op).kind === "custom" &&
    bank.replayOps([op])[5].name === "Major chord");
}

// ---- WaftWave bank -------------------------------------------------------------------------

const waftWave = (fn) => Array.from({ length: 96 }, (_, i) => Math.round(128 + 127 * fn(i / 96)));
const waftBank = (waves) => JSON.stringify({ format: "mmdt-digipro-bank", version: 2, count: waves.length, waves });

{
  const text = waftBank([
    { slot: 3, name: "SAW", data: waftWave((t) => 2 * t - 1), _dpHeat: 1 },
    { slot: 0, name: "SIN", data: waftWave((t) => Math.sin(2 * Math.PI * t)), _dpHeat: 1 },
    { slot: 7, name: "NUL", data: new Array(96).fill(128) },
  ]);
  const waves = imp.parseWaftBank(text);
  ok("WaftWave: waves in slot order, silent slot skipped", same(waves.map((w) => w.slot), [0, 3]));
  ok("WaftWave: names carry slot and name", waves[0].name === "WaftWave 01 SIN" && waves[1].name === "WaftWave 04 SAW");
  ok("WaftWave: 96 samples in -1..+1", waves[0].samples.length === 96 &&
    Math.max(...waves[0].samples) <= 1 && Math.min(...waves[0].samples) >= -1);
  ok("WaftWave: 128 is silence", imp.parseWaftBank(waftBank([{ slot: 0, name: "X", data: [128, 255, 128, 0, 128, 255, 128, 0] }]))[0].samples[0] === 0);
  const { report } = conditionCycle(waves[0].samples, { harmonics: 40 });
  ok("WaftWave: a sine conditions with almost nothing discarded", report.discardedEnergyPct < 0.5, report.discardedEnergyPct);
  ok("WaftWave: bytes parse like text", imp.parseWaftBank(new TextEncoder().encode(text)).length === 2);
  ok("WaftWave: older dataU8 field is read",
    imp.parseWaftBank(waftBank([{ slot: 1, name: "OLD", dataU8: waftWave((t) => (t < 0.5 ? 1 : -1)) }])).length === 1);
}
ok("WaftWave: other JSON is refused", throws(() => imp.parseWaftBank('{"format":"something-else","waves":[]}')));
ok("WaftWave: broken JSON is refused", throws(() => imp.parseWaftBank("{nope")));
ok("WaftWave: a bank of silence is refused", throws(() => imp.parseWaftBank(waftBank([{ slot: 0, data: new Array(96).fill(128) }]))));
ok("WaftWave: out-of-range and repeated slots are skipped", imp.parseWaftBank(waftBank([
  { slot: 64, data: waftWave(Math.sin) }, { slot: 2, data: waftWave(Math.sin) }, { slot: 2, data: waftWave(Math.cos) },
])).length === 1);

// ---- spreading 64 over 31 ------------------------------------------------------------------

{
  const s = imp.spreadIndices(64, 31);
  ok("spread: 31 of 64, first and last kept", s.length === 31 && s[0] === 0 && s[30] === 63);
  ok("spread: ascending, no repeats", s.every((x, i) => i === 0 || x > s[i - 1]));
  ok("spread: fewer than room keeps all", same(imp.spreadIndices(5, 31), [0, 1, 2, 3, 4]));
  ok("spread: room of one", same(imp.spreadIndices(10, 1), [0]));
}

// ---- ZIP of WAVs ---------------------------------------------------------------------------

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A minimal ZIP writer: files = [{ name, bytes, method: 0|8 }]. CRCs are left at zero; the reader ignores them. */
async function makeZip(files) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.method === 8 ? await deflateRaw(f.bytes) : f.bytes;
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, f.method, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, f.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30); local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, f.method, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local); centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

const wavOf = (fn, n = 96) => encodeWavFloat32(Float64Array.from({ length: n }, (_, i) => fn(i / n)), 44100);

{
  const zip = await makeZip([
    { name: "bank/MM-WAVE-02-SAW.wav", bytes: wavOf((t) => 2 * t - 1), method: 8 },
    { name: "bank/", bytes: new Uint8Array(0), method: 0 },
    { name: "bank/MM-WAVE-01-SIN.wav", bytes: wavOf((t) => Math.sin(2 * Math.PI * t)), method: 0 },
    { name: "__MACOSX/bank/._MM-WAVE-01-SIN.wav", bytes: new Uint8Array(40), method: 0 },
    { name: "bank/readme.txt", bytes: new TextEncoder().encode("hi"), method: 8 },
    { name: "bank/MM-WAVE-03-BAD.wav", bytes: new TextEncoder().encode("not a wav"), method: 0 },
  ]);
  const { waves, skipped } = await imp.wavsFromZip(zip);
  ok("ZIP: WAVs in name order, folders and resource forks skipped",
    same(waves.map((w) => w.name), ["MM-WAVE-01-SIN.wav", "MM-WAVE-02-SAW.wav"]), waves.map((w) => w.name).join(","));
  ok("ZIP: an unreadable WAV is counted, not fatal", skipped === 1);
  ok("ZIP: deflated and stored entries decode to the same length", waves.every((w) => w.samples.length === 96));
  ok("ZIP: the deflated saw came back intact", Math.abs(waves[1].samples[0] + 1) < 1e-6 && Math.abs(waves[1].samples[48]) < 1e-6);
}
ok("ZIP: not a ZIP is refused", await rejects(imp.wavsFromZip(new Uint8Array(100))));
ok("ZIP: a ZIP without WAVs is refused",
  await rejects(imp.wavsFromZip(await makeZip([{ name: "a.txt", bytes: new Uint8Array(4), method: 0 }]))));

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
