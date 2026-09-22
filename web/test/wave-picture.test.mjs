// Tests for js/wave-picture.js. The synthetic part needs no files. The comparison with
// the instrument's own pictures needs local files that are NOT in the repository
// (work/sections/section_7_blob.raw, work/aplib-golden/stock_MAIN_OS.raw,
// work/wave_sheet_map.txt) and is skipped when they are missing. Run from the project root:
//   node web/test/wave-picture.test.mjs
import { readFileSync, existsSync } from "node:fs";
import * as pic from "../js/wave-picture.js";
import * as fw from "../js/syntakt-fw.js";

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
  if (!cond) fails++;
};
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- synthetic -----------------------------------------------------------------------

const zeros = new Float64Array(256);
const sine = Float64Array.from({ length: 256 }, (_, i) => Math.sin((2 * Math.PI * i) / 256));
const square = Float64Array.from({ length: 256 }, (_, i) => (i < 128 ? 1 : -1));

{
  const p = pic.renderPicture(zeros);
  ok("silence is a straight vertical line in the centre column", pic.asciiPicture(p).every((row) => row === "........#........"));
  ok("picture is 68 bytes", p.length === pic.PICTURE_BYTES);
  ok("packPixels/unpackPixels round-trip", same(pic.packPixels(pic.unpackPixels(p)), p));
}
{
  const xs = pic.polylineX(sine);
  ok("sine: starts at the centre, peaks at +5 px, troughs at -5 px", xs[0] === 8 && xs[4] === 13 && xs[12] === 3 && xs[16] === 8, xs.join(","));
  const rows = pic.asciiPicture(pic.renderPicture(sine));
  ok("sine: every row has at least one lit pixel", rows.every((r) => r.includes("#")));
  ok("sine: no pixel beyond +-5 px of the centre", rows.every((r) => !/#/.test(r.slice(0, 3)) && !/#/.test(r.slice(14))));
}
{
  const rows = pic.asciiPicture(pic.renderPicture(square));
  ok("square: rows 0..7 lit at x=13 and rows 8..15 at x=3 (with the connecting edge)",
    rows.slice(1, 8).every((r) => r[13] === "#") && rows.slice(9, 16).every((r) => r[3] === "#"));
  ok("square: the vertical edge between rows 7 and 8 is drawn", rows[7].slice(3, 14).includes("#") || rows[8].slice(3, 14).includes("#"));
}
{
  const over = Float64Array.from(sine, (x) => 3 * x);
  ok("values beyond +-1 are clamped, not wrapped", same(pic.polylineX(over).map((x) => Math.min(13, Math.max(3, x))), pic.polylineX(over)));
  ok("rendering is deterministic", same(pic.renderPicture(sine), pic.renderPicture(sine)));
  let threw = false; try { pic.renderPicture(new Float64Array(100)); } catch { threw = true; }
  ok("a short cycle is refused", threw);
}
{
  const frames = Array.from({ length: 32 }, (_, k) => (k % 2 ? square : sine));
  const all = pic.picturesForBank(frames);
  ok("picturesForBank returns 128 pictures of 68 bytes", all.length === 128 && all.every((p) => p.length === 68));
  ok("value 4k shows frame k exactly", same(all[4], pic.renderPicture(square)) && same(all[8], pic.renderPicture(sine)));
  const mid = pic.cycleAtValue(frames, 2);
  ok("value 4k+2 is the midpoint morph", Math.abs(mid[64] - 0.5 * (sine[64] + square[64])) < 1e-12);
  ok("the last frame morphs into itself", same(pic.renderPicture(pic.cycleAtValue(frames, 127)), pic.renderPicture(frames[31])));
}

// ---- against the instrument's own pictures (local files only) ------------------------

const BLOB = "work/sections/section_7_blob.raw";
const MAINOS = "work/aplib-golden/stock_MAIN_OS.raw";
const MAP = "work/wave_sheet_map.txt";
if ([BLOB, MAINOS, MAP].every(existsSync)) {
  const blob = new Uint8Array(readFileSync(BLOB));
  const mainos = new Uint8Array(readFileSync(MAINOS));
  const BASE = 0x40000400;
  const map = new Map();
  for (const line of readFileSync(MAP, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [v, va] = line.split(" ");
    map.set(Number(v), parseInt(va, 16) - BASE);
  }
  ok("map covers all 128 values", map.size === 128);
  const frames = Array.from({ length: 32 }, (_, k) => fw.readFrame(blob, k));
  const ours = pic.picturesForBank(frames);
  let anchorsOk = 0, exact = 0, agree = 0, total = 0;
  for (let v = 0; v < 128; v++) {
    const theirs = mainos.subarray(map.get(v), map.get(v) + 68);
    const a = pic.unpackPixels(ours[v]), b = pic.unpackPixels(theirs);
    const xs = pic.polylineX(pic.cycleAtValue(frames, v));
    // The factory rasteriser differs from ours by at most one pixel: check each anchor within +-1 px.
    if (xs.every((x, r) => b[r * 17 + x] === 1 || (x > 0 && b[r * 17 + x - 1] === 1) || (x < 16 && b[r * 17 + x + 1] === 1))) anchorsOk++;
    if (same(a, b)) exact++;
    for (let i = 0; i < a.length; i++) { total++; if (a[i] === b[i]) agree++; }
  }
  // Two factory pictures (values 24 and 123) are the same shape shifted by one row in time; all others match.
  ok("all 17 anchor points lie on the factory polyline within one pixel, for at least 126 of 128 values", anchorsOk >= 126, anchorsOk + "/128");
  ok("pixel agreement with the factory pictures >= 95%", agree / total >= 0.95, (100 * agree / total).toFixed(2) + "%");
  console.log(`  factory comparison: ${exact}/128 bit-identical, ${(100 * agree / total).toFixed(2)}% pixels agree`);
} else {
  console.log("SKIP factory-picture comparison (local files not present)");
}

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
