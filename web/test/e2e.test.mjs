// End-to-end test of the workbench flow, through the plug-in interface the page uses:
//   tool.createState() -> edits as operations -> tool.summarise/contribute -> workbench.buildImage.
// The tool module is imported exactly as the browser imports it, view code included.
// Needs the (never committed) firmware files in work/. Run from the project root:
//   node web/test/e2e.test.mjs
import { readFileSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";
import * as wb from "../js/workbench.js";
import * as bank from "../js/bank.js";
import { conditionCycle } from "../js/wave-dsp.js";
import { tool } from "../js/tools/sychord-waves.js";

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
  if (!cond) fails++;
};
const same = (a, b) => fw.diffRange(a, b) === null;
const frameBytes = (section, k) => section.subarray(fw.frameOffset(k), fw.frameOffset(k) + bank.FRAME_BYTES);
const rd = (p) => new Uint8Array(readFileSync(p));

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
  ok("a fresh tool state is plain data", JSON.stringify(st) === '{"ops":[],"defaultHarmonics":40,"allowFrame0":false,"revertToFactory":false}');
  ok("summarise() of a fresh state is empty", tool.summarise(st, ctx).length === 0);
  ok("contribute() of a fresh state is empty", tool.contribute(st, ctx).length === 0);
  const built = await wb.buildImage(stock, []);
  ok("an empty queue rebuilds the loaded image byte for byte", same(built.file, stockBytes));
}

// ---- the conditioning the tool runs on an imported WAV --------------------------------

{
  const { cycle, report } = conditionCycle(saw, { harmonics: 40 });
  ok("saw conditioned: 256 samples, 40 harmonics, rising start",
    cycle.length === 256 && report.harmonicsKept === 40 && cycle[0] === 0 && cycle[1] > 0 && cycle[255] < 0);
}

// ---- (a) stock image + one insert at frame 30 -------------------------------------------

const insertState = { ...tool.createState(), ops: [bank.makeOp(30, "insert", "saw.wav", saw, 40)] };
let stockBuild = null;
{
  const ctx = await ctxOf(stock);
  const lines = tool.summarise(insertState, ctx);
  ok("summarise() describes the insert in the instrument's own words",
    lines.length === 1 && lines[0] === "Insert saw.wav at WAVE 120. The waves above it move up one step.", lines.join(" | "));

  const parts = tool.contribute(insertState, ctx);
  ok("contribute() returns one rewritten copy of section 7",
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

  const st = { ...tool.createState(), ops: [bank.makeOp(1, "replace", "square.wav", square, 40)] };
  const parts = tool.contribute(st, ctx);
  const out = await wb.buildImage(base, parts.map((p) => ({ modId: tool.id, ...p })));
  const section = fw.getSection(out.parsed, 7);

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
  const withStock = { ...ctx, stockParsed: stock };
  const reverted = { ...st, revertToFactory: true };
  const lines = tool.summarise(reverted, withStock);
  ok("revert: summarise says the waves go back to the original ones",
    lines.length === 2 && lines[0] === "Put all waves back to the original ones.", lines.join(" | "));
  const out2 = await wb.buildImage(base, tool.contribute(reverted, withStock).map((p) => ({ modId: tool.id, ...p })));
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
  const locked = { ...tool.createState(), ops: [bank.makeOp(0, "replace", "sine.wav", saw, 40)] };
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
