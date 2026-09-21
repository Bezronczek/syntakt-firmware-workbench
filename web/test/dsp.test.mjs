// Tests for js/wave-dsp.js. No firmware and no files needed: every WAV used here is
// generated in memory. Run from the project root:
//   node web/test/dsp.test.mjs
import * as dsp from "../js/wave-dsp.js";

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
  if (!cond) fails++;
};

const TWO_PI = Math.PI * 2;
const sawAt = (i, n) => (2 * i) / n - 1;          // naive ramp, -1 .. +1
const maxAbs = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

// ---- helper: build a WAV file in memory --------------------------------------------

function makeWav(samples, opts = {}) {
  const { bits = 16, float = false, channels = 1, sampleRate = 44100,
    extensible = false, extraChunk = false } = opts;
  const bytesPerSample = bits >> 3;
  const blockAlign = bytesPerSample * channels;
  const dataBytes = samples.length * blockAlign;
  const fmtSize = extensible ? 40 : 16;
  const extraSize = 5; // deliberately odd, so the pad byte is exercised
  const extraTotal = extraChunk ? 8 + extraSize + 1 : 0;
  const total = 12 + 8 + fmtSize + extraTotal + 8 + dataBytes;
  const bytes = new Uint8Array(total);
  const v = new DataView(bytes.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };

  tag(0, "RIFF"); v.setUint32(4, total - 8, true); tag(8, "WAVE");
  let p = 12;
  tag(p, "fmt "); v.setUint32(p + 4, fmtSize, true);
  const f = p + 8;
  v.setUint16(f, extensible ? 0xfffe : (float ? 3 : 1), true);
  v.setUint16(f + 2, channels, true);
  v.setUint32(f + 4, sampleRate, true);
  v.setUint32(f + 8, sampleRate * blockAlign, true);
  v.setUint16(f + 12, blockAlign, true);
  v.setUint16(f + 14, bits, true);
  if (extensible) {
    v.setUint16(f + 16, 22, true);      // cbSize
    v.setUint16(f + 18, bits, true);    // valid bits
    v.setUint32(f + 20, channels === 1 ? 4 : 3, true); // channel mask
    v.setUint16(f + 24, float ? 3 : 1, true);          // sub-format GUID, first field
    const guidTail = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00,
      0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    for (let i = 0; i < guidTail.length; i++) v.setUint8(f + 26 + i, guidTail[i]);
  }
  p = f + fmtSize;
  if (extraChunk) {
    tag(p, "LIST"); v.setUint32(p + 4, extraSize, true);
    for (let i = 0; i < extraSize; i++) v.setUint8(p + 8 + i, 0x41);
    p += 8 + extraSize + 1;
  }
  tag(p, "data"); v.setUint32(p + 4, dataBytes, true);
  let o = p + 8;
  for (let i = 0; i < samples.length; i++) {
    for (let c = 0; c < channels; c++) {
      const x = c === 0 ? samples[i] : -samples[i] / 2; // other channels must be ignored
      if (float && bits === 32) v.setFloat32(o, x, true);
      else if (float) v.setFloat64(o, x, true);
      else if (bits === 8) v.setUint8(o, Math.max(0, Math.min(255, Math.round(x * 128) + 128)));
      else if (bits === 16) v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x * 32768))), true);
      else if (bits === 24) {
        const q = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388608))) & 0xffffff;
        v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255);
      } else v.setInt32(o, Math.max(-2147483648, Math.min(2147483647, Math.round(x * 2147483648))), true);
      o += bytesPerSample;
    }
  }
  return bytes;
}

// ---- WAV decoding ------------------------------------------------------------------

const ref = Float64Array.from({ length: 300 }, (_, i) => Math.sin((TWO_PI * i) / 300) * 0.8);
const worst = (dec) => Math.max(...[...dec].map((x, i) => Math.abs(x - ref[i])));

// One quantisation step of the integer format: the honest round-trip bound.
const lsb = (bits) => 2 / Math.pow(2, bits);

for (const [label, opts, tol] of [
  ["16-bit PCM mono", { bits: 16 }, lsb(16)],
  ["24-bit PCM mono", { bits: 24 }, lsb(24)],
  ["32-bit float mono", { bits: 32, float: true }, 1e-7],
  ["8-bit PCM mono", { bits: 8 }, lsb(8)],
  ["32-bit PCM stereo, first channel only", { bits: 32, channels: 2 }, lsb(32)],
  ["16-bit WAVE_FORMAT_EXTENSIBLE", { bits: 16, extensible: true }, lsb(16)],
  ["float32 extensible with an odd-sized unknown chunk", { bits: 32, float: true, extensible: true, extraChunk: true }, 1e-7],
]) {
  const d = dsp.decodeWav(makeWav(ref, opts));
  ok("decodeWav: " + label,
    d.samples.length === ref.length && d.sampleRate === 44100 && worst(d.samples) <= tol,
    "len=" + d.samples.length + " err=" + worst(d.samples));
}

const rt = dsp.decodeWav(dsp.encodeWavFloat32(ref, 48000));
ok("encodeWavFloat32 round-trips through decodeWav",
  rt.sampleRate === 48000 && rt.channels === 1 && worst(rt.samples) < 1e-7);

for (const [label, buf] of [
  ["a file that is not RIFF", new Uint8Array(64)],
  ["a truncated header", new Uint8Array(4)],
]) {
  let threw = false;
  try { dsp.decodeWav(buf); } catch { threw = true; }
  ok("decodeWav rejects " + label, threw);
}
{
  const bad = makeWav(ref, { bits: 16 });
  new DataView(bad.buffer).setUint16(20, 0x0011, true); // IMA ADPCM
  let msg = "";
  try { dsp.decodeWav(bad); } catch (e) { msg = e.message; }
  ok("decodeWav rejects a compressed format with a readable message", /unsupported WAV encoding/.test(msg), msg);
}

// ---- conditionCycle: band limiting -------------------------------------------------

const saw2048 = Float64Array.from({ length: 2048 }, (_, i) => sawAt(i, 2048));
const sawOut = dsp.conditionCycle(saw2048, { harmonics: 40 });
ok("conditionCycle returns 256 samples", sawOut.cycle.length === 256);
ok("report: 2048 in, 40 harmonics kept",
  sawOut.report.inputLength === 2048 && sawOut.report.harmonicsKept === 40);

const mag = dsp.harmonicMagnitudes(sawOut.cycle, 127);
let worstRatio = 0;
for (let n = 1; n <= 40; n++) worstRatio = Math.max(worstRatio, Math.abs((mag[n] * n) / mag[1] - 1));
ok("saw: harmonic magnitudes fall off as 1/n up to harmonic 40 (within 1%)",
  worstRatio < 0.01, "worst deviation " + (worstRatio * 100).toFixed(3) + "%");

let above = 0;
for (let n = 41; n <= 127; n++) above = Math.max(above, mag[n]);
ok("saw: nothing survives above harmonic 40", above < 1e-9 * mag[1], "max " + above.toExponential(2));

ok("saw: discarded energy is reported and plausible (a few %)",
  sawOut.report.discardedEnergyPct > 0.5 && sawOut.report.discardedEnergyPct < 5,
  sawOut.report.discardedEnergyPct.toFixed(3) + "%");

// ---- conditionCycle: phase alignment -----------------------------------------------

const risingStart = (c) => c[0] === 0 && c[1] > 0 && c[255] < 0;
ok("saw: the cycle starts at a rising zero crossing", risingStart(sawOut.cycle),
  "y0=" + sawOut.cycle[0] + " y1=" + sawOut.cycle[1] + " y255=" + sawOut.cycle[255]);
ok("saw: forcing y[0] = 0 introduces no step (y[1] and y[255] straddle zero symmetrically)",
  Math.abs(sawOut.cycle[1] + sawOut.cycle[255]) < 0.02 * maxAbs(sawOut.cycle),
  "y1+y255=" + (sawOut.cycle[1] + sawOut.cycle[255]).toExponential(2));

{
  // Independent check that the shift really lands on a zero of the series, not near one.
  const H = 40;
  const { a, b } = dsp.dftHarmonics(saw2048, H);
  const s = sawOut.report.shiftFraction;
  ok("saw: the reported shift is a true zero of the band-limited series",
    Math.abs(dsp.evalSeries(a, b, s)) < 1e-12 && dsp.evalSeries(a, b, s + 1e-6) > 0,
    "f(shift)=" + dsp.evalSeries(a, b, s).toExponential(2));
}

let sineWorst = 0;
for (const phase of [0, 0.13, 0.25, 0.5, 0.77, 0.999]) {
  for (const sign of [1, -1]) {
    const n = 512;
    const inp = Float64Array.from({ length: n }, (_, i) => sign * 0.37 * Math.sin(TWO_PI * (i / n + phase)));
    const { cycle } = dsp.conditionCycle(inp, { harmonics: 40 });
    let e = 0;
    for (let i = 0; i < 256; i++) e = Math.max(e, Math.abs(cycle[i] - 0.37 * Math.sin((TWO_PI * i) / 256)));
    sineWorst = Math.max(sineWorst, e);
    if (!risingStart(cycle)) { ok("sine phase " + phase + " sign " + sign + " starts rising", false); }
  }
}
ok("a sine of any phase and polarity comes out as a rising sine",
  sineWorst < 1e-9, "worst deviation " + sineWorst.toExponential(2));

// ---- conditionCycle: DC, odd lengths, edge cases -----------------------------------

{
  const n = 1024;
  const inp = Float64Array.from({ length: n }, (_, i) => 0.5 + sawAt(i, n)); // big DC offset
  const { cycle } = dsp.conditionCycle(inp, { harmonics: 32 });
  let mean = 0;
  for (const x of cycle) mean += x;
  mean /= 256;
  ok("DC is removed", Math.abs(mean) < 1e-12, "mean " + mean.toExponential(2));
}

{
  const n = 600; // not a power of two
  const inp = Float64Array.from({ length: n }, (_, i) => sawAt(i, n));
  const { cycle, report } = dsp.conditionCycle(inp, { harmonics: 40 });
  ok("a 600-sample input works and still starts rising",
    cycle.length === 256 && report.inputLength === 600 && report.harmonicsKept === 40 && risingStart(cycle));
}

{
  const inp = Float64Array.from({ length: 16 }, (_, i) => Math.sin((TWO_PI * i) / 16));
  const { report } = dsp.conditionCycle(inp, { harmonics: 127 });
  ok("harmonics are clamped to floor(N/2) - 1 for short inputs", report.harmonicsKept === 7,
    "kept " + report.harmonicsKept);
}

{
  const inp = Float64Array.from({ length: 256 }, (_, i) => Math.sin((TWO_PI * i) / 256));
  const { report } = dsp.conditionCycle(inp, { harmonics: 9999 });
  ok("harmonics never exceed 127", report.harmonicsKept === 127);
}

for (const [label, input, opts] of [
  ["a silent input", new Float64Array(256), {}],
  ["a constant input", Float64Array.from({ length: 256 }, () => 0.7), {}],
  ["an input shorter than 8 samples", new Float64Array(4), {}],
  ["a waveform that lies entirely above the band limit",
    Float64Array.from({ length: 512 }, (_, i) => Math.sin((TWO_PI * 100 * i) / 512)), { harmonics: 40 }],
]) {
  let threw = false;
  try { dsp.conditionCycle(input, opts); } catch { threw = true; }
  ok("conditionCycle rejects " + label, threw);
}

{
  // Band limit actually changes the result: fewer harmonics, less high-frequency content.
  const a8 = dsp.conditionCycle(saw2048, { harmonics: 8 });
  const m8 = dsp.harmonicMagnitudes(a8.cycle, 127);
  let above8 = 0;
  for (let n = 9; n <= 127; n++) above8 = Math.max(above8, m8[n]);
  ok("band limit 8 keeps only 8 harmonics",
    a8.report.harmonicsKept === 8 && above8 < 1e-9 * m8[1] &&
    a8.report.discardedEnergyPct > sawOut.report.discardedEnergyPct);
}

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
