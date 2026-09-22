// End-to-end test of the workbench flow, through the plug-in interface the page uses:
//   tool.createState() -> edits as operations -> tool.summarise/contribute -> workbench.buildImage.
// The tool module is imported exactly as the browser imports it, view code included.
// Needs the (never committed) firmware files in work/. Run from the project root:
//   node web/test/e2e.test.mjs
import { readFileSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";
import * as wb from "../js/workbench.js";
import * as bank from "../js/bank.js";
import { getMod } from "../js/mods.js";
import { conditionCycle } from "../js/wave-dsp.js";
import { renderPicture, picturesForBank, PICTURE_BYTES } from "../js/wave-picture.js";
import { BLOCK_OF_VALUE, OPERANDS, SECTION_BASE } from "../js/sychord-picture-map.js";
import { tool } from "../js/tools/sychord-waves.js";

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
  if (!cond) fails++;
};
const same = (a, b) => fw.diffRange(a, b) === null;
const frameBytes = (section, k) => section.subarray(fw.frameOffset(k), fw.frameOffset(k) + bank.FRAME_BYTES);
const rd = (p) => new Uint8Array(readFileSync(p));
const ms = (t0) => Math.round(performance.now() - t0) + " ms";
const be32 = (a, o) => ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0;
const block = (section, v) => section.subarray(BLOCK_OF_VALUE[v], BLOCK_OF_VALUE[v] + PICTURE_BYTES);
/** The three WAVE values that do not own a picture block; a pointer sends them to a neighbour's. */
const SHARED = new Set(OPERANDS.map((o) => o.value));

const stockBytes = rd("work/Syntakt_OS1.41.syx");
ok("the firmware in work/ is the supported OS 1.41", (await fw.sha256hex(stockBytes)) in fw.SUPPORTED);
const stock = fw.parseSyx(stockBytes);
const factory = fw.getSection(stock, fw.WAVE.SECTION_ID);

const N = 2048;
const saw = Float64Array.from({ length: N }, (_, i) => (2 * i) / N - 1);
const square = Float64Array.from({ length: 1024 }, (_, i) => (i < 512 ? 1 : -1));

// The workbench hands every tool the same context object.
const ctxOf = async (parsed, stockParsed) => ({
  baseParsed: parsed,
  stockParsed: stockParsed || null,
  present: (await wb.verifyImage(parsed)).mods,
});

// ---- (d) a fresh state queues nothing ------------------------------------------------

{
  const st = tool.createState();
  const ctx = await ctxOf(stock);
  ok("a fresh tool state is plain data",
    JSON.stringify(st) === '{"ops":[],"defaultHarmonics":40,"allowFrame0":false,"revertToFactory":false,"drawPictures":true}',
    JSON.stringify(st));
  ok("the pictures on the screen are drawn by default", st.drawPictures === true);
  ok("summarise() of a fresh state is empty", tool.summarise(st, ctx).length === 0);
  ok("contribute() of a fresh state is empty, pictures or not", tool.contribute(st, ctx).length === 0 &&
    tool.contribute({ ...st, drawPictures: false }, ctx).length === 0);
  const built = await wb.buildImage(stock, []);
  ok("an empty queue rebuilds the loaded image byte for byte", same(built.file, stockBytes));
  ok("  ... and says so: same size in, same size out",
    built.report.sizeBefore === stockBytes.length && built.report.sizeAfter === stockBytes.length);
}

// ---- the conditioning the tool runs on an imported WAV --------------------------------

{
  const { cycle, report } = conditionCycle(saw, { harmonics: 40 });
  ok("saw conditioned: 256 samples, 40 harmonics, rising start",
    cycle.length === 256 && report.harmonicsKept === 40 && cycle[0] === 0 && cycle[1] > 0 && cycle[255] < 0);
}

// ---- (a) stock image + one insert at frame 30, waves only --------------------------------

// The same insert appears twice on purpose: once with the screen pictures switched off, which
// touches section 7 alone and cannot change the size of anything, and once with them on.
const insertState = { ...tool.createState(), ops: [bank.makeOp(30, "insert", "saw.wav", saw, 40)], drawPictures: false };
let stockBuild = null;
{
  const ctx = await ctxOf(stock);
  const lines = tool.summarise(insertState, ctx);
  ok("summarise() describes the insert in the instrument's own words",
    lines.length === 1 && lines[0] === "Insert saw.wav at WAVE 120. The waves above it move up one step.", lines.join(" | "));

  const parts = tool.contribute(insertState, ctx);
  ok("with the pictures off, contribute() returns one rewritten copy of section 7",
    parts.length === 1 && parts[0].section === 7 && parts[0].bytes.length === factory.length);

  stockBuild = await wb.buildImage(stock, parts.map((p) => ({ modId: tool.id, ...p })));
  const out = fw.getSection(stockBuild.parsed, 7);

  ok("build: no stray writes outside the mod's regions", stockBuild.report.strayWrites.length === 0);
  ok("insert at 30: the new frame 31 is bit-identical to the stock frame 30 (raw 257-sample copy)",
    same(frameBytes(out, 31), frameBytes(factory, 30)));
  ok("insert at 30: frames 1..29 are bit-for-bit untouched",
    Array.from({ length: 29 }, (_, i) => i + 1).every((k) => same(frameBytes(out, k), frameBytes(factory, k))));
  ok("insert at 30: the shared sine (frame 0) is bit-for-bit untouched", same(frameBytes(out, 0), frameBytes(factory, 0)));
  ok("insert at 30: frame 30 did change", !same(frameBytes(out, 30), frameBytes(factory, 30)));
  ok("the output has exactly the size of the image it was built from", stockBuild.file.length === stockBytes.length);

  const v = await wb.verifyImage(stockBuild.parsed);
  ok("the built image verifies as exactly the wave mod and nothing else",
    v.ok && !v.isStock && v.mods.length === 1 && v.mods[0].id === "sychord-waves" && v.unknown.length === 0);
  ok("  ... and only the wave bank region, not the shared sine", v.mods[0].regions.length === 1);

  const written = fw.readFrame(out, 30);
  let peak = 0;
  for (const x of written) peak = Math.max(peak, Math.abs(x));
  ok("frame 30 was stored normalised, starting at a rising zero crossing",
    written[0] === 0 && written[1] > 0 && written[255] < 0 && Math.abs(peak - 1) < 1e-4, "peak " + peak);
  const dv = new DataView(out.buffer, out.byteOffset + fw.frameOffset(30), bank.FRAME_BYTES);
  ok("frame 30 guard sample equals the first sample", dv.getInt32(0) === dv.getInt32(1024));

  ok("changedFrames() reports exactly the frames the build rewrote",
    tool.changedFrames(insertState, ctx).join() === "30,31");
}

// ---- (a) the same insert with the screen pictures on -----------------------------------
//
// The one full-effort build in this file: it packs the MAIN OS section at level 3, which is
// what the hardware-proven chain does and what the page does, and takes about 20 seconds.

{
  const ctx = await ctxOf(stock);
  const withPics = { ...insertState, drawPictures: true };
  const lines = tool.summarise(withPics, ctx);
  ok("summarise() adds one line for the pictures, after the change itself",
    lines.length === 2 && lines[1] === "Wave pictures on the screen updated to match.", lines.join(" | "));

  const parts = tool.contribute(withPics, ctx);
  const raw3 = fw.getSectionRaw(stock, 3);
  ok("contribute() returns section 7 and the decompressed MAIN OS section, in that order",
    parts.length === 2 && parts[0].section === 7 && parts[1].section === 3 &&
    parts[1].bytes.length === raw3.length, parts.map((p) => p.section + ":" + p.bytes.length).join(" "));
  ok("  ... and a line for the build checklist", typeof parts[1].note === "string" && parts[1].note.length > 0);
  ok("the section-7 bytes are the same with the pictures on and off",
    same(parts[0].bytes, tool.contribute(insertState, ctx)[0].bytes));
  ok("contributing twice gives byte-identical pictures", same(parts[1].bytes, tool.contribute(withPics, ctx)[1].bytes));

  const t0 = performance.now();
  const built = await wb.buildImage(stock, parts.map((p) => ({ modId: tool.id, section: p.section, bytes: p.bytes })));
  const level3 = ms(t0);
  const out7 = fw.getSection(built.parsed, 7);
  const out3 = fw.getSectionRaw(built.parsed, 3);

  ok(`the level-3 build reports the size it produced [${level3}]`,
    built.report.sizeBefore === stockBytes.length && built.report.sizeAfter === built.file.length &&
    built.report.sizeAfter !== built.report.sizeBefore, JSON.stringify(built.report.strayWrites));
  ok("no stray writes, in either section", built.report.strayWrites.length === 0);
  ok("the waves are exactly the ones the pictures-off build wrote", same(out7, fw.getSection(stockBuild.parsed, 7)));

  const v = await wb.verifyImage(built.parsed);
  ok("the built image verifies as exactly the wave mod and nothing else",
    v.ok && !v.isStock && v.mods.length === 1 && v.mods[0].id === "sychord-waves" && v.unknown.length === 0,
    JSON.stringify(v.unknown));
  ok("  ... listing the wave bank, the pictures and all three picture pointers",
    v.mods[0].regions.length === 5 && v.mods[0].regions.includes("wave bank, frames 1-31") &&
    v.mods[0].regions.includes("wave pictures on the screen") &&
    OPERANDS.every((o) => v.mods[0].regions.includes("picture pointer for WAVE " + o.value)),
    v.mods[0].regions.join(" | "));

  const regions = getMod("sychord-waves").regions.filter((r) => r.section === 3);
  const declared = (i) => regions.some((r) => i >= r.start && i < r.end);
  let outside = 0, changedInside = 0;
  for (let i = 0; i < out3.length; i++) {
    if (out3[i] === raw3[i]) continue;
    if (declared(i)) changedInside++; else outside++;
  }
  ok("MAIN OS differs from the official file only inside the declared regions",
    outside === 0 && changedInside > 0, outside + " bytes outside, " + changedInside + " inside");

  const frames = Array.from({ length: 32 }, (_, k) => fw.readFrame(out7, k));
  const expected = picturesForBank(frames);
  let wrong = 0;
  for (let v2 = 0; v2 < 128; v2++) if (!SHARED.has(v2) && !same(block(out3, v2), expected[v2])) wrong++;
  ok("every WAVE value that owns a picture block holds the picture of the wave it plays", wrong === 0, wrong + " wrong");
  ok("the pictures at WAVE 4k are the key frames themselves",
    [0, 4, 30].every((k) => same(block(out3, 4 * k), renderPicture(frames[k]))));
  ok("the changed wave really changed its picture", !same(block(out3, 120), block(raw3, 120)));
  ok("the three shared values point at the block of the value next to them",
    OPERANDS.every((o) => be32(out3, o.pointer) === SECTION_BASE + BLOCK_OF_VALUE[o.showValue]) &&
    OPERANDS.some((o) => be32(out3, o.pointer) !== be32(raw3, o.pointer)),
    OPERANDS.map((o) => o.value + "->0x" + be32(out3, o.pointer).toString(16)).join(" "));
}

// ---- (c) the state survives storage: clone -> identical contribution bytes -----------------

{
  const ctx = await ctxOf(stock);
  const clone = structuredClone(insertState);
  ok("a cloned state keeps the raw samples as a Float64Array",
    clone.ops[0].samples instanceof Float64Array && clone.ops[0].samples.length === N &&
    clone.ops[0].samples[7] === insertState.ops[0].samples[7]);
  ok("serialise -> deserialise -> identical summary", tool.summarise(clone, ctx).join("|") === tool.summarise(insertState, ctx).join("|"));
  const a = tool.contribute(insertState, ctx)[0].bytes;
  const b = tool.contribute(clone, ctx)[0].bytes;
  ok("serialise -> deserialise -> byte-identical contribution", same(a, b));
  const pic = structuredClone({ ...insertState, drawPictures: true });
  ok("the screen-picture setting survives storage", pic.drawPictures === true &&
    tool.contribute(pic, ctx).length === 2 &&
    same(tool.contribute(pic, ctx)[1].bytes, tool.contribute({ ...insertState, drawPictures: true }, ctx)[1].bytes));
  const rebuilt = await wb.buildImage(stock, [{ modId: tool.id, section: 7, bytes: b }]);
  ok("  ... and the whole image is byte-identical too", same(rebuilt.file, stockBuild.file));
}

// ---- (b) an image built here as the base, WITHOUT the official file ------------------------

{
  const baseBytes = rd("work/syntakt141_sychord_saw30.syx");
  const base = fw.parseSyx(baseBytes);
  const baseSection = fw.getSection(base, 7);
  const ctx = await ctxOf(base); // stockParsed stays null on purpose

  ok("the base image is recognised without the official file",
    ctx.present.length === 1 && ctx.present[0].id === "sychord-waves");

  // The pictures are on here, on top of an image that was built before they existed. Level 0
  // keeps the test fast: what the packed stream looks like is container.test.mjs's business.
  const st = { ...tool.createState(), ops: [bank.makeOp(1, "replace", "square.wav", square, 40)] };
  const parts = tool.contribute(st, ctx);
  ok("stacking: the pictures are drawn on top of an image that never had them",
    parts.length === 2 && parts[1].section === 3);
  const out = await wb.buildImage(base, parts.map((p) => ({ modId: tool.id, section: p.section, bytes: p.bytes })),
    undefined, undefined, { level: 0 });
  const section = fw.getSection(out.parsed, 7);
  const out3 = fw.getSectionRaw(out.parsed, 3);
  const frames = Array.from({ length: 32 }, (_, k) => fw.readFrame(section, k));
  ok("stacking: the pictures show the waves that are in the file now, the old one included",
    same(block(out3, 4), renderPicture(frames[1])) && same(block(out3, 120), renderPicture(frames[30])));
  ok("stacking: the file changed size, and the build says by how much",
    out.report.sizeAfter === out.file.length && out.report.sizeBefore === baseBytes.length);

  ok("stacking: frame 30 is still bit-identical to the base image's own frame 30",
    same(frameBytes(section, 30), frameBytes(baseSection, 30)) && !same(frameBytes(section, 30), frameBytes(factory, 30)));
  ok("stacking: frame 31 is still bit-identical to the base image's own frame 31",
    same(frameBytes(section, 31), frameBytes(baseSection, 31)));
  ok("stacking: only frame 1 was written by this build",
    tool.changedFrames(st, ctx).join() === "1" && !same(frameBytes(section, 1), frameBytes(baseSection, 1)));
  const v = await wb.verifyImage(out.parsed);
  ok("stacking: the result verifies with the wave mod and nothing unknown", v.ok && v.mods.length === 1 && v.unknown.length === 0);
  ok("stacking: no stray writes", out.report.strayWrites.length === 0);

  // with the official file in the context the tool can put the factory waves back
  // (pictures off: this is about the waves, and it keeps the section-7-only path covered here too)
  const withStock = { ...ctx, stockParsed: stock };
  const reverted = { ...st, revertToFactory: true, drawPictures: false };
  const lines = tool.summarise(reverted, withStock);
  ok("revert: summarise says the waves go back to the original ones",
    lines.length === 2 && lines[0] === "Put all waves back to the original ones.", lines.join(" | "));
  const out2 = await wb.buildImage(base, tool.contribute(reverted, withStock).map((p) => ({ modId: tool.id, ...p })));
  ok("revert: with the pictures off the file keeps the size it had", out2.file.length === baseBytes.length);
  const s2 = fw.getSection(out2.parsed, 7);
  ok("revert: the factory frame 30 is back, bit for bit", same(frameBytes(s2, 30), frameBytes(factory, 30)));
  ok("revert: the new frame 1 is the same wave as without the revert", same(frameBytes(s2, 1), frameBytes(section, 1)));
  ok("revert without the official file is ignored, not guessed",
    tool.summarise({ ...tool.createState(), revertToFactory: true }, ctx).length === 0);
}

// ---- the operations list: what the tool state actually stores --------------------------------

{
  const ctx = await ctxOf(stock);
  const ops = [bank.makeOp(30, "insert", "saw.wav", saw, 40)];
  const replayed = bank.replayOps(ops);
  ok("ops replay: slot 30 is the custom wave, slot 31 the old factory frame 30",
    replayed[30].kind === "custom" && replayed[31].kind === "factory" && replayed[31].from === 30);
  ok("ops replay: frames 0..29 are untouched identities",
    Array.from({ length: 30 }, (_, k) => k).every((k) => bank.isIdentity(replayed[k], k)));
  ok("badges read factory / custom / moved",
    bank.entryState(replayed[29], 29) === "factory" && bank.entryState(replayed[30], 30) === "custom" &&
    bank.entryState(replayed[31], 31) === "moved");
  ok("replaying the same list twice gives the same bytes",
    same(bank.buildSection(factory, bank.replayOps(ops), {}).section, bank.buildSection(factory, replayed, {}).section));
  ok("insert at frame 0 is refused (the sine never moves)", (() => {
    try { bank.insertAt(bank.initialBank(), 0, bank.customEntry("x", saw, 40)); return false; } catch { return true; }
  })());
  ok("frame 0 can only be replaced: makeOp downgrades an insert there",
    bank.makeOp(0, "insert", "x.wav", saw, 40).mode === "replace");

  // a queued frame-0 change is ignored while frame 0 is locked, and written once it is unlocked
  // (pictures off, so this stays a section-7-only build)
  const locked = { ...tool.createState(), ops: [bank.makeOp(0, "replace", "sine.wav", saw, 40)], drawPictures: false };
  ok("frame 0 locked: the queue is empty", tool.summarise(locked, ctx).length === 0 && tool.contribute(locked, ctx).length === 0);
  const unlocked = { ...locked, allowFrame0: true };
  const b0 = await wb.buildImage(stock, tool.contribute(unlocked, ctx).map((p) => ({ modId: tool.id, ...p })));
  const s0 = fw.getSection(b0.parsed, 7);
  ok("frame 0 unlocked: the shared sine is written", !same(frameBytes(s0, 0), frameBytes(factory, 0)));
  const v0 = await wb.verifyImage(b0.parsed);
  ok("  ... and the image still verifies, with only the sine region reported as changed",
    v0.ok && v0.mods.length === 1 && v0.mods[0].regions.length === 1 && v0.mods[0].regions[0].startsWith("frame 0"),
    JSON.stringify(v0.mods));
}

{
  // A second Replace of the same frame supersedes the first one; an Insert never does.
  const a = bank.makeOp(4, "replace", "a.wav", saw, 20);
  const bb = bank.makeOp(4, "replace", "b.wav", saw, 30);
  const c = bank.makeOp(4, "insert", "c.wav", saw, 30);
  let ops = bank.addOp(bank.addOp([], a), bb);
  ok("a second Replace on a frame supersedes the earlier one",
    ops.length === 1 && ops[0].name === "b.wav" && bank.replayOps(ops)[4].name === "b.wav");
  ops = bank.addOp(ops, c);
  ok("an Insert is always appended, never merged", ops.length === 2 && bank.replayOps(ops)[4].name === "c.wav");
  ok("  ... and it pushes the replaced frame up one slot", bank.replayOps(ops)[5].name === "b.wav");
}

{
  // Removing an operation restores the previous bytes exactly.
  const o1 = bank.makeOp(3, "replace", "one.wav", saw, 24);
  const o2 = bank.makeOp(9, "insert", "two.wav", saw, 40);
  const o3 = bank.makeOp(20, "replace", "three.wav", saw, 64);
  const sectionOf = (ops) => bank.buildSection(factory, bank.replayOps(ops), {}).section;
  ok("removing the last operation restores the earlier section byte for byte",
    same(sectionOf(bank.removeOp([o1, o2, o3], 2)), sectionOf([o1, o2])));
  const middleRemoved = bank.removeOp([o1, o2, o3], 1);
  ok("removing a middle operation replays the rest in order",
    same(sectionOf(middleRemoved), sectionOf([o1, o3])) &&
    bank.replayOps(middleRemoved)[3].name === "one.wav" && bank.replayOps(middleRemoved)[20].name === "three.wav");
  ok("removing every operation gives back the untouched section", same(sectionOf([]), factory));
  const reharm = bank.setOpHarmonics([o1, o2, o3], 0, 12);
  ok("changing one operation's band limit re-derives that wave from its own samples",
    bank.opEntry(reharm[0]).report.harmonicsKept === 12 && bank.opEntry(o1).report.harmonicsKept === 24);
  ok("opIndexForSlot finds the operation that owns a slot",
    bank.opIndexForSlot([o1, o2, o3], 20) === 2 && bank.opIndexForSlot([o1, o2, o3], 3) === 0 &&
    bank.opIndexForSlot([o1, o2, o3], 2) === -1);
}

{
  // Filling consecutive frames, as dropping several WAVs on the strip does.
  const many = [1, 2, 3].map((n) => bank.customEntry("w" + n + ".wav", saw, 20 + n));
  const filled = bank.fillFrom(bank.initialBank(), 1, many);
  ok("fillFrom writes consecutive slots starting at 1",
    filled[1].name === "w1.wav" && filled[3].name === "w3.wav" && bank.isIdentity(filled[4], 4) &&
    bank.fillCapacity(1) === 31);
  const re = bank.recondition(bank.replayOps([bank.makeOp(30, "insert", "saw.wav", saw, 40)]), 12);
  ok("recondition re-derives custom frames from the stored input samples",
    re[30].report.harmonicsKept === 12 && bank.isIdentity(re[0], 0) && re[31].from === 30);
}

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
