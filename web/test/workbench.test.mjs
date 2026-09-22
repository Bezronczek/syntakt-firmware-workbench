// Tests for the workbench core: stock-less validation by fingerprints, and the multi-mod build.
// Needs local firmware files in work/. Run from the project root:  node web/test/workbench.test.mjs
import { readFileSync, existsSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";
import * as wb from "../js/workbench.js";
import { MODS, getMod } from "../js/mods.js";
import { BLOCK_REGION, OPERANDS } from "../js/sychord-picture-map.js";
import { FINGERPRINTS } from "../js/fingerprints.js";

const rd = (p) => new Uint8Array(readFileSync(p));
const load = (p) => fw.parseSyx(rd(p));
let fails = 0;
const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fails++; };
const throws = async (fn) => { try { await fn(); return false; } catch { return true; } };

const stock = load("work/Syntakt_OS1.41.syx");
const fresh = await wb.computeFingerprints(stock);
ok("shipped fingerprints match the stock file and the current registry", JSON.stringify(fresh) === JSON.stringify(FINGERPRINTS));
ok("fingerprints hold digests only (small file, no long byte runs)", JSON.stringify(FINGERPRINTS).length < 4000);

let v = await wb.verifyImage(stock);
ok("stock verifies as stock", v.ok && v.isStock && v.mods.length === 0);

v = await wb.verifyImage(load("work/syntakt141_sychord_saw30.syx"));
ok("saw image verifies WITHOUT the stock file: wave mod present, bank region only", v.ok && !v.isStock && v.mods.length === 1 && v.mods[0].id === "sychord-waves" && v.mods[0].regions.length === 1);

v = await wb.verifyImage(load("work/WEBTOOL_combo_build.syx"));
ok("the stacked image flashed today verifies", v.ok && v.mods[0].id === "sychord-waves");

v = await wb.verifyImage(load("work/EXPERIMENT2_frame0.syx"));
ok("frame-0 experiment: both regions reported", v.ok && v.mods[0].regions.length === 2);

v = await wb.verifyImage(load("work/EXPERIMENT_frame0.syx"));
ok("experiment 1 (bytes outside any mod) is refused", !v.ok && v.unknown.some((u) => u.section === 7));

v = await wb.verifyImage(load("work/repack_D.syx"));
ok("a repacked image with a byte changed outside every mod is refused", !v.ok && v.unknown.some((u) => u.section === 3));

ok("stale fingerprints are detected", await throws(() => wb.verifyImage(stock, [...MODS, { id: "x", title: "X", regions: [{ section: 7, start: 0, end: 4, label: "x" }] }])));

// ---- compressed sections ----
// MAIN OS is stored as an aPLib stream: the mod regions are offsets into its DECOMPRESSED bytes,
// and packing it again moves every section after it, so the file changes size. Level 0 keeps this
// file fast; container.test.mjs is where the packed bytes themselves are checked.
const raw3 = fw.getSectionRaw(stock, 3);
ok("section 3 is compressed, section 7 is not", fw.isCompressed(stock, 3) && !fw.isCompressed(stock, 7));
ok("the shipped fingerprints know that, and how long the section really is",
  FINGERPRINTS.sections[3].compressed === true && FINGERPRINTS.sections[3].rawLength === raw3.length &&
  !FINGERPRINTS.sections[7].compressed);

// an image that only went through the rebuild: official content, unofficial bytes
const rebuilt = existsSync("work/repack_C.syx") ? load("work/repack_C.syx") : fw.replaceSection(stock, 3, raw3, { level: 0 });
v = await wb.verifyImage(rebuilt);
ok("a rebuilt image with unchanged content: accepted, not stock, nothing queued in it",
  v.ok && !v.isStock && v.recompressed && v.mods.length === 0 && v.unknown.length === 0, JSON.stringify(v.unknown));
ok("  ... and its sections really did move", rebuilt.sections.find((s) => s.id === 7).offset !== stock.sections.find((s) => s.id === 7).offset);
ok("the official file itself is stock and not recompressed", (await wb.verifyImage(stock)).isStock && !(await wb.verifyImage(stock)).recompressed);

const insidePic = raw3.slice();
insidePic[BLOCK_REGION.start + 17] ^= 0xff;
insidePic[OPERANDS[0].pointer + 3] ^= 0x0f;
v = await wb.verifyImage(fw.replaceSection(stock, 3, insidePic, { level: 0 }));
ok("a change inside the picture regions is the wave mod, on its decompressed bytes",
  v.ok && v.mods.length === 1 && v.mods[0].id === "sychord-waves" && v.mods[0].regions.length === 2 &&
  v.mods[0].regions.includes("wave pictures on the screen"), JSON.stringify(v));

const outsidePic = raw3.slice();
outsidePic[BLOCK_REGION.start - 1] ^= 0xff;
v = await wb.verifyImage(fw.replaceSection(stock, 3, outsidePic, { level: 0 }));
ok("one byte outside them is refused, naming the section",
  !v.ok && v.unknown.length === 1 && v.unknown[0].section === 3, JSON.stringify(v.unknown));

// a contribution to a compressed section carries its decompressed bytes
const pics = raw3.slice();
pics.fill(0x5a, BLOCK_REGION.start, BLOCK_REGION.end);
const cb = await wb.buildImage(stock, [{ modId: "sychord-waves", section: 3, bytes: pics }], undefined, undefined, { level: 0 });
ok("building writes a compressed section from raw bytes and reports the new size",
  cb.report.strayWrites.length === 0 && cb.report.sizeBefore === stock.file.length &&
  cb.report.sizeAfter === cb.file.length && cb.report.sizeAfter !== cb.report.sizeBefore);
ok("  ... the pictures went in, byte for byte", fw.getSectionRaw(cb.parsed, 3)[BLOCK_REGION.start] === 0x5a &&
  fw.diffRange(fw.getSectionRaw(cb.parsed, 3).subarray(0, BLOCK_REGION.start), raw3.subarray(0, BLOCK_REGION.start)) === null);
ok("  ... and every other section is untouched",
  stock.sections.filter((s) => s.id !== 3).every((s) => fw.diffRange(fw.getSection(stock, s.id), fw.getSection(cb.parsed, s.id)) === null));

const strayPics = raw3.slice();
strayPics[BLOCK_REGION.start] ^= 0xff;
strayPics[BLOCK_REGION.start - 2] ^= 0xff;
const cb2 = await wb.buildImage(stock, [{ modId: "sychord-waves", section: 3, bytes: strayPics }], undefined, undefined, { level: 0 });
ok("a write outside the declared regions of a compressed section is dropped and reported",
  cb2.report.strayWrites[0]?.count === 1 && fw.getSectionRaw(cb2.parsed, 3)[BLOCK_REGION.start - 2] === raw3[BLOCK_REGION.start - 2]);
ok("a contribution with the packed length instead of the raw one is refused",
  await throws(() => wb.buildImage(stock, [{ modId: "sychord-waves", section: 3, bytes: fw.getSection(stock, 3) }], undefined, undefined, { level: 0 })));

// ---- build pipeline ----
const sawSection = rd("work/section_7_saw_at30.raw");
let b = await wb.buildImage(stock, [{ modId: "sychord-waves", section: 7, bytes: sawSection }]);
ok("workbench build == hardware-proven saw image, byte for byte", fw.diffRange(b.file, rd("work/syntakt141_sychord_saw30.syx")) === null);
ok("  ... no stray writes, wave mod reported", b.report.strayWrites.length === 0 && b.report.mods[0].id === "sychord-waves");

b = await wb.buildImage(stock, []);
ok("empty queue rebuilds the base image unchanged", fw.diffRange(b.file, stock.file) === null);

// stacking: base = saw image, contribution = the combo image's section 7 -> must equal the combo image flashed today
const combo = load("work/WEBTOOL_combo_build.syx");
b = await wb.buildImage(load("work/syntakt141_sychord_saw30.syx"), [{ modId: "sychord-waves", section: 7, bytes: fw.getSection(combo, 7) }]);
ok("stacked build == the combo image flashed today, byte for byte", fw.diffRange(b.file, combo.file) === null);

// a mod that scribbles outside its regions: the scribble is dropped and reported
const dirty = sawSection.slice(); dirty[0x100] ^= 0xff; dirty[0x5d400] ^= 0xff;
b = await wb.buildImage(stock, [{ modId: "sychord-waves", section: 7, bytes: dirty }]);
ok("writes outside a mod's regions are discarded and reported", b.report.strayWrites[0]?.count === 2 && fw.diffRange(b.file, rd("work/syntakt141_sychord_saw30.syx")) === null);

ok("a base image that does not verify is refused", await throws(() => wb.buildImage(load("work/EXPERIMENT_frame0.syx"), [])));
ok("a contribution of the wrong size is refused", await throws(() => wb.buildImage(stock, [{ modId: "sychord-waves", section: 7, bytes: sawSection.subarray(1) }])));
ok("a contribution to a section the mod does not declare is refused", await throws(() => wb.buildImage(stock, [{ modId: "sychord-waves", section: 6, bytes: fw.getSection(stock, 6) }])));

// two mods sharing a section: synthetic registry + matching fingerprints
const waves = getMod("sychord-waves");
const neighbour = { id: "neighbour", title: "Neighbour", regions: [{ section: 7, start: 0x1e3fc, end: 0x1e800, label: "table after the bank" }] };
const clash = { id: "clash", title: "Clash", regions: [{ section: 7, start: 0x1e000, end: 0x1e400, label: "overlaps frame 1" }] };
const reg2 = [waves, neighbour], fp2 = await wb.computeFingerprints(stock, reg2);
const nb = fw.getSection(stock, 7); nb.fill(0x11, 0x1e3fc, 0x1e800);
b = await wb.buildImage(stock, [{ modId: "sychord-waves", section: 7, bytes: sawSection }, { modId: "neighbour", section: 7, bytes: nb }], reg2, fp2);
const s7 = fw.getSection(b.parsed, 7);
ok("two mods in one section combine: each contributes only its own regions",
  b.report.mods.map((m) => m.id).sort().join() === "neighbour,sychord-waves" && s7[0x1e3fc] === 0x11 && fw.diffRange(s7.subarray(0, 0x1e3fc), sawSection.subarray(0, 0x1e3fc)) === null);
v = await wb.verifyImage(load("work/EXPERIMENT_frame0.syx"), reg2, fp2);
ok("with 'neighbour' registered, experiment 1 is still refused (it also touched the 513-sample sine)", !v.ok);

const reg3 = [waves, clash], fp3 = await wb.computeFingerprints(stock, reg3);
ok("conflictsAmong names the colliding pair", JSON.stringify(wb.conflictsAmong(["sychord-waves", "clash"], reg3)) === '[{"a":"sychord-waves","b":"clash"}]');
ok("buildImage refuses colliding mods", await throws(() => wb.buildImage(stock, [{ modId: "sychord-waves", section: 7, bytes: sawSection }, { modId: "clash", section: 7, bytes: sawSection }], reg3, fp3)));

// ---- progress reporting ------------------------------------------------------------------
{
  const seen = [];
  const raw3 = fw.getSectionRaw(stock, 3);
  const pr = await wb.buildImage(stock, [{ modId: "sychord-waves", section: 3, bytes: raw3 }], undefined, undefined,
    { level: 0, onProgress: (p) => seen.push(p) });
  ok("buildImage reports packing progress for a compressed section",
    seen.length >= 2 && seen.every((p) => p.phase === "pack" && p.section === 3) && seen[0].fraction === 0 && seen[seen.length - 1].fraction === 1,
    JSON.stringify(seen.slice(0, 2)));
  ok("  ... and the build with progress still verifies", (await wb.verifyImage(pr.parsed)).ok);
  const none = [];
  await wb.buildImage(stock, [{ modId: "sychord-waves", section: 7, bytes: sawSection }], undefined, undefined, { onProgress: (p) => none.push(p) });
  ok("a raw-only build reports no packing progress", none.length === 0);
}

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
