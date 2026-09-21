// Tests for the workbench core: stock-less validation by fingerprints, and the multi-mod build.
// Needs local firmware files in work/. Run from the project root:  node web/test/workbench.test.mjs
import { readFileSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";
import * as wb from "../js/workbench.js";
import { MODS, getMod } from "../js/mods.js";
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
ok("recompressed MAIN OS image is refused", !v.ok);

ok("stale fingerprints are detected", await throws(() => wb.verifyImage(stock, [...MODS, { id: "x", title: "X", regions: [{ section: 7, start: 0, end: 4, label: "x" }] }])));

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

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
