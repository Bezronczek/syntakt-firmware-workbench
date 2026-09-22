// Tests for the mod registry / compatibility engine. Needs local firmware files in work/.
// Run from the project root:  node web/test/mods.test.mjs
import { readFileSync, existsSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";
import * as mods from "../js/mods.js";
import { BLOCK_REGION } from "../js/sychord-picture-map.js";

const rd = (p) => new Uint8Array(readFileSync(p));
let fails = 0;
const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fails++; };

ok("the shipped registry has no overlapping mods", mods.registryConflicts().length === 0);

const stock = fw.parseSyx(rd("work/Syntakt_OS1.41.syx"));
let r = mods.analyseImage(stock, stock);
ok("stock vs stock: nothing found", r.mods.length === 0 && r.unknown.length === 0);

// hardware-proven images made earlier in the project
r = mods.analyseImage(stock, fw.parseSyx(rd("work/syntakt141_sychord_saw30.syx")));
ok("saw image: recognised as the wave-bank mod only", r.unknown.length === 0 && r.mods.length === 1 && r.mods[0].id === "sychord-waves");
ok("  ... bank region only, not the shared sine", r.mods[0].regions.length === 1 && r.mods[0].regions[0].startsWith("wave bank"));
ok("  ... 1970 bytes changed (matches the Python patcher's count)", r.mods[0].bytesChanged === 1970);

r = mods.analyseImage(stock, fw.parseSyx(rd("work/EXPERIMENT2_frame0.syx")));
ok("frame-0 experiment: both regions of the wave mod detected", r.unknown.length === 0 && r.mods[0].regions.length === 2);

r = mods.analyseImage(stock, fw.parseSyx(rd("work/EXPERIMENT_frame0.syx")));
ok("experiment 1 (bytes outside any mod) is refused as unknown", r.unknown.length > 0 && r.unknown.every((u) => u.section === 7));

r = mods.analyseImage(stock, fw.parseSyx(rd("work/repack_D.syx")));
ok("a repacked image with a byte changed outside every mod is refused",
  r.unknown.length > 0 && r.unknown.every((u) => u.section === 3));

// ---- compressed sections: compared on the bytes the device sees ----------------------------
// Packing MAIN OS again moves every section after it and changes the size of the file. That on
// its own is not a change to anything: only the decompressed bytes count.
const raw3 = fw.getSectionRaw(stock, 3);
const rebuilt = existsSync("work/repack_C.syx")
  ? fw.parseSyx(rd("work/repack_C.syx"))
  : fw.replaceSection(stock, 3, raw3, { level: 0 });
r = mods.analyseImage(stock, rebuilt);
ok("a rebuilt image with unchanged content: nothing found, nothing unknown",
  r.mods.length === 0 && r.unknown.length === 0);
ok("  ... although its sections moved and the file is a different size",
  rebuilt.container.length !== stock.container.length);

const inside = raw3.slice();
inside[BLOCK_REGION.start] ^= 0xff;
inside[BLOCK_REGION.end - 1] ^= 0xff;
r = mods.analyseImage(stock, fw.replaceSection(stock, 3, inside, { level: 0 }));
ok("a change inside the picture region is the wave mod, with the bytes counted",
  r.unknown.length === 0 && r.mods.length === 1 && r.mods[0].bytesChanged === 2 &&
  r.mods[0].regions.join() === "wave pictures on the screen", JSON.stringify(r));

const outside = raw3.slice();
outside[BLOCK_REGION.end] ^= 0xff;
r = mods.analyseImage(stock, fw.replaceSection(stock, 3, outside, { level: 0 }));
ok("one byte past the end of the region is unknown", r.unknown.length === 1 && r.unknown[0].section === 3);

ok("the container shell ignores the offsets and lengths a rebuild rewrites",
  fw.diffRange(mods.containerShell(stock), mods.containerShell(rebuilt)) === null &&
  mods.layoutIsRight(rebuilt) && mods.paddingIsClean(rebuilt));

// synthetic registry: a second mod next to the bank, and a third one colliding with it
const waves = mods.getMod("sychord-waves");
const neighbour = { id: "neighbour", title: "Neighbour", regions: [{ section: 7, start: 0x1e3fc, end: 0x1e800, label: "table after the bank" }] };
const clash = { id: "clash", title: "Clash", regions: [{ section: 7, start: 0x1e000, end: 0x1e400, label: "overlaps frame 1" }] };
const reg = [waves, neighbour, clash];
ok("adjacent regions do not conflict ([start, end) semantics)", mods.conflictsBetween(waves, neighbour).length === 0);
ok("overlapping regions conflict", mods.conflictsBetween(waves, clash).length === 1);
ok("registryConflicts reports the clash pairs", mods.registryConflicts(reg).map((c) => c.a + "+" + c.b).sort().join() === "neighbour+clash,sychord-waves+clash");
ok("checkCompatible: waves on top of neighbour is fine", mods.checkCompatible("sychord-waves", ["neighbour"], reg).ok);
const cc = mods.checkCompatible("sychord-waves", ["neighbour", "clash"], reg);
ok("checkCompatible: waves on top of clash is refused, naming it", !cc.ok && cc.conflicts.length === 1 && cc.conflicts[0].with === "clash");
ok("checkCompatible: re-editing your own mod is fine", mods.checkCompatible("sychord-waves", ["sychord-waves"], reg).ok);

r = mods.analyseImage(stock, fw.parseSyx(rd("work/EXPERIMENT_frame0.syx")), reg);
ok("with 'neighbour' registered, part of experiment 1 is attributed to it", r.mods.some((m) => m.id === "neighbour"));

// verifyAgainstStock: the final gate
const saw = fw.parseSyx(rd("work/syntakt141_sychord_saw30.syx"));
ok("verifyAgainstStock accepts the saw image for the wave mod", mods.verifyAgainstStock(stock, saw, ["sychord-waves"]).ok);
ok("verifyAgainstStock refuses it when the wave mod is not allowed", !mods.verifyAgainstStock(stock, saw, []).ok);

const runs = mods.diffRuns(Uint8Array.of(1, 2, 3, 4, 5, 6), Uint8Array.of(1, 9, 9, 4, 5, 9));
ok("diffRuns finds maximal runs", JSON.stringify(runs) === "[[1,3],[5,6]]");

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
