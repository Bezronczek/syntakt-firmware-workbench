// Golden tests for the container rebuild in js/syntakt-fw.js: replacing a COMPRESSED
// section, whose packed length changes, and putting the whole .syx back together.
// The reference is the C chain (mischa85's elektron-firmware-tool) whose images booted on
// the device. Needs the (never committed) firmware files in work/. Run from the project root:
//   node web/test/container.test.mjs
//
// It packs MAIN OS at level 3 twice; that is ~16 s each in Node and is the point of the test.
import { readFileSync, existsSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";

const W = "work/";
const NEEDED = [
  "Syntakt_OS1.41.syx",
  "repack_C.syx",
  "repack_D.syx",
  "aplib-golden/stock_MAIN_OS.raw",
];
const missing = NEEDED.filter((f) => !existsSync(W + f));
if (missing.length) {
  console.log("SKIP  container tests: missing golden file(s) in work/: " + missing.join(", "));
  console.log("      Supply your own copies there; they are never part of this repository.");
  process.exit(0);
}

const rd = (p) => new Uint8Array(readFileSync(W + p));
let fails = 0;
const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fails++; };
const same = (a, b) => fw.diffRange(a, b) === null;
const ms = (t0) => Math.round(performance.now() - t0) + " ms";
function throws(name, fn, want) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  ok(name + (msg ? ` -> "${msg.slice(0, 64)}"` : " -> returned instead of throwing"),
    msg !== null && (!want || msg.includes(want)));
}

// The one byte that separates repack_D from repack_C. It is an offset inside the
// DECOMPRESSED section, i.e. an input to the codec under test, not a firmware finding.
const D_PATCH = { offset: 0x2531b9, from: 0x4f, to: 0x30 };

const MAIN_OS = 3, WAVES = 7;

const stock = rd("Syntakt_OS1.41.syx");
const p = fw.parseSyx(stock);
const table = (q) => q.sections.map((s) => `${s.id}@${s.offset}+${s.length}`).join(" ");

// ---- 1. the file the parser was given comes back out of the builder ------------------

ok(`buildSyx(parseSyx(official)) is byte-identical (${stock.length} B, ${p.data.length} packets)`,
  same(stock, fw.buildSyx(p)));
// codec.test.mjs covers the same-length replaceRawSection round trip; not repeated here.

// ---- 2. which sections are compressed, and what they hold ---------------------------

const comp = p.sections.filter((s) => fw.isCompressed(p, s.id)).map((s) => s.id).sort();
const raws = p.sections.filter((s) => !fw.isCompressed(p, s.id)).map((s) => s.id).sort();
ok(`isCompressed splits the 8 sections into compressed [${comp}] and raw [${raws}]`,
  comp.length + raws.length === 8 && comp.length > 0 && raws.length > 0);
ok("getSectionRaw on a raw section returns the stored bytes unchanged",
  same(fw.getSectionRaw(p, WAVES), fw.getSection(p, WAVES)));

const raw3 = rd("aplib-golden/stock_MAIN_OS.raw");
ok(`getSectionRaw(MAIN OS) == the C tool's decompressed section (${raw3.length} B)`,
  fw.isCompressed(p, MAIN_OS) && same(fw.getSectionRaw(p, MAIN_OS), raw3));

// ---- 3. recompressing a compressed section, byte for byte against the C tool ---------

let t0 = performance.now();
const cParsed = fw.replaceSection(p, MAIN_OS, raw3, { level: 3 });
const cBuilt = fw.buildSyx(cParsed);
const cMs = ms(t0);
ok(`replaceSection(official, ${MAIN_OS}, stock_MAIN_OS.raw, level 3) == work/repack_C.syx` +
  ` [${cBuilt.length} B, ${cMs}]`, same(rd("repack_C.syx"), cBuilt));

const patched = raw3.slice();
ok(`the byte at 0x${D_PATCH.offset.toString(16)} of the decompressed section is 0x${D_PATCH.from.toString(16)} as expected`,
  patched[D_PATCH.offset] === D_PATCH.from);
patched[D_PATCH.offset] = D_PATCH.to;
t0 = performance.now();
const dBuilt = fw.buildSyx(fw.replaceSection(p, MAIN_OS, patched, { level: 3 }));
const dMs = ms(t0);
ok(`... with that one byte changed == work/repack_D.syx [${dBuilt.length} B, ${dMs}]`,
  same(rd("repack_D.syx"), dBuilt));
ok("the two rebuilds differ from each other (the patch really went in)", !same(cBuilt, dBuilt));

// ---- 4. the rebuilt image is a consistent image -------------------------------------

// parseSyx verifies every packet checksum and the container checksum, so this re-parse is
// the whole integrity check; it already ran inside replaceSection, here on the file bytes.
const again = fw.parseSyx(cBuilt);
ok("the rebuilt file re-parses (all checksums verify) and keeps its version",
  again.version === p.version && again.sections.length === p.sections.length);
ok("getSectionRaw(rebuilt, MAIN OS) returns the bytes that went in", same(fw.getSectionRaw(again, MAIN_OS), raw3));
ok("every other section is unchanged, byte for byte",
  p.sections.filter((s) => s.id !== MAIN_OS).every((s) => same(fw.getSection(p, s.id), fw.getSection(again, s.id))));
ok("ids and dest addresses are carried over untouched",
  p.sections.every((s, i) => again.sections[i].id === s.id && again.sections[i].dest === s.dest));

// The stored length shrank, so MAIN OS and everything after it sits somewhere else.
const shrank = again.sections.find((s) => s.id === MAIN_OS).length < p.sections.find((s) => s.id === MAIN_OS).length;
ok(`recompression changed the stored length: ${p.sections.find((s) => s.id === MAIN_OS).length}` +
  ` -> ${again.sections.find((s) => s.id === MAIN_OS).length}`, shrank);

/** The layout rule: sections in offset order, each 16-byte aligned, starting where they did. */
function layoutIsRight(q) {
  const order = q.sections.map((s) => s).sort((a, b) => a.offset - b.offset);
  let pos = Math.min(...q.sections.map((s) => s.offset));
  for (const s of order) {
    pos = pos + ((16 - (pos % 16)) % 16);
    if (s.offset !== pos) return false;
    pos += s.length;
  }
  return q.container.length === pos + ((16 - (pos % 16)) % 16);
}
ok("the rebuilt table follows the layout rule (offset order, 16-byte aligned, padded end)", layoutIsRight(again));
ok("  ... and so does the original", layoutIsRight(p));

// ---- 5. raw sections still go through the same rebuild ------------------------------

const s7 = fw.getSection(p, WAVES);
ok("replaceSection of a raw section with its own bytes reproduces the official file", same(stock, fw.buildSyx(fw.replaceSection(p, WAVES, s7))));
const edited = s7.slice();
edited[0x1000] ^= 0xff;
ok("replaceSection and replaceRawSection agree byte for byte on a same-length raw edit",
  same(fw.replaceRawSection(p, WAVES, edited), fw.buildSyx(fw.replaceSection(p, WAVES, edited))));
throws("replaceRawSection still refuses a wrong-length replacement",
  () => fw.replaceRawSection(p, WAVES, s7.subarray(0, s7.length - 4)), "exactly the size");
throws("replaceSection refuses an unknown section id", () => fw.replaceSection(p, 99, s7), "no section 99");

// ---- 6. a length change moves every later section ------------------------------------

// A cheap compressed section (level 0, so this stays fast) with content that cannot pack to
// the same size: its packed length changes and the table must absorb the difference.
const OTHER = comp.find((id) => id !== MAIN_OS && p.sections.find((s) => s.id === id).length < 200000);
const oRaw = fw.getSectionRaw(p, OTHER);
const oEdit = oRaw.slice();
for (let i = 0; i < oEdit.length; i += 97) oEdit[i] ^= 0xa5; // defeats the matcher; grows the stream
t0 = performance.now();
const moved = fw.replaceSection(p, OTHER, oEdit, { level: 0 });
const mMs = ms(t0);
const before = p.sections.find((s) => s.id === OTHER), after = moved.sections.find((s) => s.id === OTHER);
const delta = after.length - before.length;
ok(`replacing compressed section ${OTHER} changed its packed length by ${delta} B [${mMs}]`, delta !== 0);
ok("  ... the layout rule still holds for the whole table", layoutIsRight(moved));
ok(`  ... sections after it moved: ${table(moved)}`,
  p.sections.every((s) => {
    const n = moved.sections.find((x) => x.id === s.id);
    return s.offset < before.offset ? n.offset === s.offset : (s.id === OTHER || n.offset !== s.offset || delta === 0);
  }));
ok("  ... their bytes are still the original ones",
  p.sections.filter((s) => s.id !== OTHER).every((s) => same(fw.getSection(p, s.id), fw.getSection(moved, s.id))));
ok(`  ... the container and the file grew with it: ${p.container.length} -> ${moved.container.length} B,` +
  ` ${stock.length} -> ${fw.buildSyx(moved).length} B`, moved.container.length > p.container.length);
ok("  ... and the edited section reads back exactly", same(fw.getSectionRaw(moved, OTHER), oEdit));

console.log("");
console.log(`timings: MAIN OS level 3 ${cMs} and ${dMs} (pack + container + transport), level-0 section ${mMs}`);
console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
