// Golden tests for js/aplib.js against the output of mischa85's elektron-firmware-tool,
// the C chain that was proven on hardware. Needs the (never committed) firmware-derived
// files in work/aplib-golden/. Run from the project root:
//   node web/test/aplib.test.mjs
//
// Chain of trust: the depacker is checked first against sections the C tool packed
// (stock streams from Elektron, plus the C tool's own level-3 recompression), and only
// then is it used to validate what our packer emits.
import { readFileSync } from "node:fs";
import * as ap from "../js/aplib.js";

const rd = (p) => new Uint8Array(readFileSync(p));
const G = "work/aplib-golden/";
let fails = 0;
const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fails++; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const ms = (t0) => (Math.round(performance.now() - t0) + " ms");
function throws(name, fn, want) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  ok(name + (msg ? ` -> "${msg.slice(0, 72)}"` : " -> returned instead of throwing"),
    msg !== null && (!want || msg.includes(want)));
}
// Header fields recomputed here, independently of the module.
const hdrLen = (s) => (s[0] << 24 | s[1] << 16 | s[2] << 8 | s[3]) >>> 0;
const hdrSum = (s) => (s[4] << 24 | s[5] << 16 | s[6] << 8 | s[7]) >>> 0;
function sumOf(s, from, to) { let a = 0; for (let i = from; i < to; i++) a = (a + s[i]) >>> 0; return a; }

const NAMES = ["bootstrap", "FPGA", "MAIN_OS", "sec8"];

// ---- 1. the depacker against the C tool's streams ------------------------------------

const raws = {}, stocks = {};
for (const n of NAMES) {
  stocks[n] = rd(`${G}stock_${n}.packed`);
  raws[n] = rd(`${G}stock_${n}.raw`);
  const t0 = performance.now();
  const got = ap.depack(stocks[n]);
  const took = ms(t0);
  ok(`depack(stock_${n}.packed) == stock_${n}.raw (${raws[n].length} bytes` +
    (n === "MAIN_OS" ? `, ${took}` : "") + ")", same(got, raws[n]));
}
const ctool = rd(`${G}ctool_MAIN_OS_level3.packed`);
ok("depack(ctool_MAIN_OS_level3.packed) == stock_MAIN_OS.raw", same(ap.depack(ctool), raws.MAIN_OS));

// ---- 2. round trips ------------------------------------------------------------------

let lastPackMs = 0;
/** pack at `level`, check the header we wrote, the offsets we used, and the round trip. */
function roundTrip(label, raw, level, { time = false } = {}) {
  const t0 = performance.now();
  const packed = ap.pack(raw, level);
  lastPackMs = performance.now() - t0;
  const took = ms(t0);
  const good = hdrLen(packed) === packed.length - 8 && hdrSum(packed) === sumOf(packed, 8, packed.length);
  ok(`  header of ${label} L${level}: length ${hdrLen(packed)} + 8 == ${packed.length}, byte-sum matches`, good);
  const stats = ap.streamStats(packed);
  ok(`  offsets of ${label} L${level} stay within MAX_OFFSET (max ${stats.maxOffset} <= ${ap.MAX_OFFSET})`,
    stats.maxOffset <= ap.MAX_OFFSET);
  ok(`depack(pack(${label}, ${level})) == ${label}` +
    ` [${raw.length} -> ${packed.length}${time ? ", pack " + took : ""}]`, same(ap.depack(packed), raw));
  return packed;
}

for (const n of ["bootstrap", "FPGA"]) for (const lv of [0, 1, 2, 3]) roundTrip(n, raws[n], lv);
for (const lv of [0, 1]) roundTrip("sec8", raws.sec8, lv);

// MAIN OS: levels 0 and 1 always; level 3 as well if it is not absurdly slow. The C tool
// needs ~16 s for it, so we budget 3 minutes and note a skip rather than fail.
const mainPacked = {};
for (const lv of [0, 1]) mainPacked[lv] = roundTrip("MAIN_OS", raws.MAIN_OS, lv, { time: true });
const l1 = mainPacked[1], l1ms = lastPackMs;

// Level 3 examines 32x the candidates level 1 does, an upper bound on how much slower it
// can be; if even that fits four times over in the budget, just run it.
const budgetMs = 180000;
let mainL3 = null;
if (l1ms * 32 > budgetMs * 4) {
  console.log(`NOTE  skipping MAIN_OS level 3: level 1 took ${Math.round(l1ms)} ms, level 3 could blow the ${budgetMs / 1000} s budget`);
} else {
  const t2 = performance.now();
  mainL3 = ap.pack(raws.MAIN_OS, 3);
  const took = performance.now() - t2;
  ok(`pack(MAIN_OS, 3) finished in ${Math.round(took)} ms (budget ${budgetMs / 1000} s)`, took <= budgetMs);
  const st = ap.streamStats(mainL3);
  ok(`  header of MAIN_OS L3: length ${hdrLen(mainL3)} + 8 == ${mainL3.length}, byte-sum matches`,
    hdrLen(mainL3) === mainL3.length - 8 && hdrSum(mainL3) === sumOf(mainL3, 8, mainL3.length));
  ok(`  offsets of MAIN_OS L3 stay within MAX_OFFSET (max ${st.maxOffset} <= ${ap.MAX_OFFSET})`, st.maxOffset <= ap.MAX_OFFSET);
  const t3 = performance.now();
  const back = ap.depack(mainL3);
  ok(`depack(pack(MAIN_OS, 3)) == MAIN_OS [unpack ${ms(t3)}]`, same(back, raws.MAIN_OS));
  ok(`pack(MAIN_OS, 3) is not larger than the stock section: ${mainL3.length} <= ${stocks.MAIN_OS.length}` +
    ` (C tool: ${ctool.length}, delta ${((mainL3.length / ctool.length - 1) * 100).toFixed(2)}%)`,
    mainL3.length <= stocks.MAIN_OS.length);
  // Strongest available evidence that the stream is one the C depacker (and the device)
  // accepts: at this level the parse is deterministic, so the bytes should be identical.
  ok("pack(MAIN_OS, 3) is byte-identical to the C tool's level-3 section", same(mainL3, ctool));
}
ok("level 1 packing is deterministic (same input, same bytes)", same(l1, ap.pack(raws.MAIN_OS, 1)));

// ---- 3. rejecting damaged input ------------------------------------------------------

const victim = stocks.bootstrap;
throws("depack rejects a section shorter than the header", () => ap.depack(victim.subarray(0, 5)), "shorter than");
{
  const t = victim.slice(0, victim.length - 100);
  throws("depack rejects a truncated section (header length past the end)", () => ap.depack(t), "only");
}
{
  const t = victim.slice(0, victim.length - 100); // truncate and make the header agree again
  const n = t.length - 8;
  t[0] = n >>> 24; t[1] = (n >>> 16) & 255; t[2] = (n >>> 8) & 255; t[3] = n & 255;
  const s = sumOf(t, 8, t.length);
  t[4] = s >>> 24; t[5] = (s >>> 16) & 255; t[6] = (s >>> 8) & 255; t[7] = s & 255;
  throws("depack rejects a truncated stream whose header was repaired", () => ap.depack(t), "input ended");
}
{
  const t = victim.slice();
  t[8 + 1000] ^= 0x40;
  throws("depack rejects a flipped stream byte (header byte-sum)", () => ap.depack(t), "byte-sum");
}
{
  const t = victim.slice();
  t[7] ^= 0x01;
  throws("depack rejects a wrong header byte-sum", () => ap.depack(t), "byte-sum");
}
{
  // Flip a byte and repair the sum, so only the stream itself can give it away. Some
  // flips still decode - to different bytes - which is why the header sum exists.
  let thrown = 0, differs = 0, identical = 0;
  for (let k = 0; k < 64; k++) {
    const t = victim.slice();
    t[8 + ((k * 211 + 37) % (t.length - 8))] ^= 1 << (k & 7);
    const s = sumOf(t, 8, t.length);
    t[4] = s >>> 24; t[5] = (s >>> 16) & 255; t[6] = (s >>> 8) & 255; t[7] = s & 255;
    try {
      if (same(ap.depack(t), raws.bootstrap)) identical++; else differs++;
    } catch { thrown++; }
  }
  ok(`64 single-bit stream corruptions with a repaired header: ${thrown} threw, ${differs} decoded to other bytes, ${identical} decoded unchanged`,
    identical === 0);
}
{
  const t = ctool.slice(0, 8); // valid header for a zero-length stream? no: length stays huge
  throws("depack rejects a header-only section that claims a stream", () => ap.depack(t), "only");
}

// ---- 4. synthetic inputs -------------------------------------------------------------

function xorshift(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x & 255; };
}
const rnd = xorshift(0x5eed1234);
const random64k = Uint8Array.from({ length: 65536 }, rnd);
const pattern = new Uint8Array(200000);
for (let i = 0; i < pattern.length; i++) pattern[i] = "SYNTAKT-".charCodeAt(i % 8);
const cases = [
  ["empty", new Uint8Array(0)],
  ["one byte", Uint8Array.of(0x42)],
  ["two bytes", Uint8Array.of(0, 0)],
  ["100 KB of zeros", new Uint8Array(100 * 1024)],
  ["64 KB of random bytes", random64k],
  ["200 KB repetitive pattern", pattern],
];
for (const [label, raw] of cases) {
  let allGood = true, sizes = [];
  for (const lv of [0, 1, 2, 3]) {
    const packed = ap.pack(raw, lv);
    sizes.push(packed.length);
    const headerOk = hdrLen(packed) === packed.length - 8 && hdrSum(packed) === sumOf(packed, 8, packed.length);
    const offsetsOk = ap.streamStats(packed).maxOffset <= ap.MAX_OFFSET;
    if (!headerOk || !offsetsOk || !same(ap.depack(packed), raw)) allGood = false;
  }
  ok(`round trip at levels 0..3: ${label} (${raw.length} -> ${sizes.join("/")})`, allGood);
}
ok("empty input packs to a bare zero header", same(ap.pack(new Uint8Array(0), 3), new Uint8Array(8)));
ok("a section may carry trailing padding after the stream (stock sections do)",
  stocks.FPGA.length > 8 + hdrLen(stocks.FPGA) && same(ap.depack(stocks.FPGA), raws.FPGA));

// ---- 5. sizes ------------------------------------------------------------------------

console.log("");
console.log("sizes (bytes):        raw      stock     ours L0     ours L1     ours L3");
for (const n of NAMES) {
  const l0 = ap.pack(raws[n], 0).length;
  const l1s = n === "MAIN_OS" ? l1.length : ap.pack(raws[n], 1).length;
  const l3 = n === "MAIN_OS" ? (mainL3 ? mainL3.length : NaN) : ap.pack(raws[n], 3).length;
  console.log(`  ${n.padEnd(12)} ${String(raws[n].length).padStart(9)} ${String(stocks[n].length).padStart(10)} ` +
    `${String(l0).padStart(11)} ${String(l1s).padStart(11)} ${String(l3).padStart(11)}`);
}
console.log(`  C tool level 3 on MAIN_OS: ${ctool.length}`);

// ---- progress reporting never changes the output ----------------------------------------
{
  const seen = [];
  const withCb = ap.pack(raws.FPGA, 1, (f) => seen.push(f));
  ok("pack with a progress callback gives the same bytes as without", same(withCb, ap.pack(raws.FPGA, 1)));
  ok("progress starts at 0, never decreases and ends at exactly 1",
    seen.length >= 2 && seen[0] === 0 && seen[seen.length - 1] === 1 && seen.every((f, i) => i === 0 || f >= seen[i - 1]),
    seen.slice(0, 3).join(",") + " ... " + seen.slice(-2).join(","));
  ok("progress is reported about every 64 KB", seen.length === Math.ceil(raws.FPGA.length / 65536) + 1, String(seen.length));
}

console.log("");
console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
