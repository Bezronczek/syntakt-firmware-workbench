// Tests for step 1 of the workbench: ONE file, and no official file required.
// Needs the (never committed) firmware files in work/. Run from the project root:
//   node web/test/firmware-input.test.mjs
import { readFileSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";
import * as step from "../js/firmware-input.js";

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
  if (!cond) fails++;
};
const rd = (p) => new Uint8Array(readFileSync(p));
const look = (p) => step.examine(p.split("/").pop(), rd(p));

const STOCK = "work/Syntakt_OS1.41.syx";
const SAW = "work/syntakt141_sychord_saw30.syx";
const COMBO = "work/WEBTOOL_combo_build.syx";
const FRAME0 = "work/EXPERIMENT2_frame0.syx";
const EXP = "work/EXPERIMENT_frame0.syx";
const REPACK = "work/repack_D.syx";

// ---- the official file ----------------------------------------------------------------

{
  const r = await look(STOCK);
  ok("the official file is recognised as stock", r.kind === step.STOCK && r.ok && r.isStock);
  ok("  ... with no mods and a headline in the user's words", r.mods.length === 0 && r.headline === "Official Syntakt firmware, OS 1.41");
  ok("  ... and it carries the parsed image, its size and a short hash",
    r.parsed && r.parsed.version === "1.41" && r.size === rd(STOCK).length && r.short.length === 12 &&
    r.hash.startsWith(r.short));
}

// ---- an image built on this site, recognised WITHOUT the official file --------------------

{
  const r = await look(SAW);
  ok("an image built here is recognised on its own", r.kind === step.SITE && r.ok && !r.isStock);
  ok("  ... the tool is named, with no firmware jargon in the primary text",
    r.modLines.length === 1 && r.modLines[0] === "SY CHORD Wave Bank", r.modLines.join(" | "));
  ok("  ... the byte ranges live in the details instead",
    r.modDetails[0] === "SY CHORD Wave Bank - wave bank, frames 1-31", r.modDetails.join(" | "));
  ok("  ... and the headline says whose file it is", r.headline === "Your image, with SY CHORD Wave Bank");

  const c = await look(COMBO);
  ok("the stacked image built on this site is accepted too", c.kind === step.SITE && c.ok && c.mods[0].id === "sychord-waves");

  const f = await look(FRAME0);
  ok("an image that also changed the shared sine reports both regions",
    f.kind === step.SITE && f.ok && f.mods[0].regions.length === 2);
}

// ---- files that must be refused ------------------------------------------------------------

{
  const r = await look(EXP);
  ok("an image with bytes outside every known mod is refused", r.kind === step.REFUSED && !r.ok);
  ok("  ... with a reason a musician can read and details to expand",
    r.headline === "This file was changed by something else" && /Load the official Syntakt OS 1.41 file/.test(r.reason) &&
    r.details.length > 0 && r.details[0].startsWith("section 7"), r.reason);
  ok("  ... and no parsed image is handed on", r.parsed === null);

  const p = await look(REPACK);
  ok("a recompressed image from another tool is refused", p.kind === step.REFUSED && !p.ok && p.details.length > 0);

  const junk = await step.examine("notes.txt", new Uint8Array(64));
  ok("a file that is not SysEx says what to do, with the technical reason in the details",
    junk.kind === step.REFUSED && junk.headline === "This file is damaged, or is not Syntakt firmware" &&
    /Download the firmware again from elektron.se/.test(junk.reason) && /could not be decoded/.test(junk.details[0]),
    junk.reason + " | " + junk.details.join(""));

  const empty = await step.examine("empty.syx", new Uint8Array(0));
  ok("an empty file is refused before anything else",
    empty.kind === step.REFUSED && empty.headline === "This file is empty");

  const damaged = rd(SAW);
  damaged[5000] ^= 0x01; // inside a data packet: the packet checksum must catch it
  const d = await step.examine("damaged.syx", damaged);
  ok("a damaged image is refused by the checksum, not silently patched", d.kind === step.REFUSED && !d.ok);
}

// ---- the optional official file ---------------------------------------------------------------

{
  const good = await step.examineStock("Syntakt_OS1.41.syx", rd(STOCK));
  ok("examineStock accepts the official file", good.ok && good.kind === step.STOCK);

  const site = await step.examineStock("mine.syx", rd(SAW));
  ok("examineStock refuses an image built here", !site.ok && site.kind === step.REFUSED);
  ok("  ... and says what to do instead", /Add the untouched Syntakt_OS1.41.syx/.test(site.reason), site.reason);

  const junk = await step.examineStock("x.syx", new Uint8Array(64));
  ok("examineStock refuses junk with the same message as examine",
    !junk.ok && /Download the firmware again/.test(junk.reason));
}

// ---- the sentences the page shows ----------------------------------------------------------------

{
  ok("describeMod is the plain name, describeModDetail adds the ranges",
    step.describeMod({ title: "X", regions: ["a", "b"] }) === "X" &&
    step.describeModDetail({ title: "X", regions: ["a", "b"] }) === "X - a, b");
  ok("describeUnknown turns a verify result into readable lines",
    step.describeUnknown([{ section: 7, reason: "changes outside every known mod" }])[0] ===
      "section 7: changes outside every known mod");
  ok("describeUnknown handles the container as well",
    step.describeUnknown([{ section: null, reason: "padding differs" }])[0] === "container: padding differs");
  ok("describeSize is the one a person reads", step.describeSize(2571424) === "2.5 MB", step.describeSize(2571424));
  ok("describeSizeExact keeps the byte count for the details",
    step.describeSizeExact(2571424) === "2571424 bytes" && step.describeSizeExact(1) === "1 byte");
  ok("shortHash is twelve hex digits", step.shortHash("0123456789abcdef".repeat(4)).length === 12);

  const img = await look(SAW);
  ok("describeImage names the file a tool is working on",
    step.describeImage(img) === "Working on " + img.name + ".",
    step.describeImage(img));
  const st = await look(STOCK);
  ok("describeImage says so plainly for the official file",
    step.describeImage(st) === "Working on Syntakt_OS1.41.syx.", step.describeImage(st));
  ok("describeImage copes with no file at all", step.describeImage(null) === "No file loaded.");
}

// ---- one drop of one or two files, in any order ----------------------------------------------------

{
  const rec = (p, name) => ({ name: name || p.split("/").pop(), bytes: rd(p) });
  const stockRec = rec(STOCK), sawRec = rec(SAW);

  let d = await step.examineDrop([stockRec]);
  ok("the official file alone is the working image and its own reference",
    d.image && d.image.kind === step.STOCK && d.stock === d.image && d.refused.length === 0);

  d = await step.examineDrop([sawRec]);
  ok("an image built here alone is the working image, with no reference",
    d.image && d.image.kind === step.SITE && d.stock === null);

  d = await step.examineDrop([sawRec, stockRec]);
  ok("both files: the site image is worked on, the official file is the reference",
    d.image.kind === step.SITE && d.stock.kind === step.STOCK && d.image !== d.stock);
  const reversed = await step.examineDrop([stockRec, sawRec]);
  ok("  ... and the order they arrive in does not matter",
    reversed.image.name === d.image.name && reversed.stock.name === d.stock.name);

  d = await step.examineDrop([sawRec, rec(COMBO)]);
  ok("two images built here: the first is used, the second is explained, not silently dropped",
    d.image.name === sawRec.name && d.notes.length === 1 && d.notes[0].includes("one image at a time"));

  d = await step.examineDrop([stockRec, rec(STOCK, "copy.syx")]);
  ok("the same official file twice is a note, not a problem", d.notes.length === 1 && d.refused.length === 0);

  d = await step.examineDrop([rec(EXP), stockRec]);
  ok("a refused file in the drop does not stop the good one",
    d.image && d.image.kind === step.STOCK && d.refused.length === 1 && d.refused[0].name === "EXPERIMENT_frame0.syx");

  d = await step.examineDrop([]);
  ok("an empty drop changes nothing", d.image === null && d.stock === null && d.refused.length === 0);
}

// ---- the recommendation to load both files ------------------------------------------------------------

{
  const image = await look(SAW);
  const stock = await look(STOCK);
  let a = step.stockAdvice(image, null);
  ok("with your own image and no official file the recommendation is shown",
    a.show && !a.have && a.text.startsWith("Recommended: add the official firmware file too"), a.text);
  ok("  ... and it says plainly that building works without it", /You can build without it/.test(a.text));
  a = step.stockAdvice(image, stock);
  ok("with both files it becomes a quiet confirmation", a.show && a.have && /Official file added/.test(a.text));
  a = step.stockAdvice(stock, null);
  ok("with the official file as the image there is nothing to recommend", !a.show && a.have);
  ok("with nothing loaded there is nothing to say", step.stockAdvice(null, null).show === false);
}

// ---- a synthetic registry: a tool blocked by a mod already in the image ---------------------------

{
  // Two mods over the same bytes cannot both be in one image; the workbench blocks the second
  // tool before it opens. Here the engine is checked directly, with digests for the fake registry.
  const stock = fw.parseSyx(rd(STOCK));
  const { computeFingerprints, conflictsAmong } = await import("../js/workbench.js");
  const { MODS } = await import("../js/mods.js");
  const clash = { id: "clash", title: "Clash", regions: [{ section: 7, start: 0x1e000, end: 0x1e400, label: "overlaps frame 1" }] };
  const registry = [...MODS, clash];
  const fingerprints = await computeFingerprints(stock, registry);

  const r = await step.examine("mine.syx", rd(SAW), { registry, fingerprints });
  ok("with a second, overlapping mod registered the saw image is still accepted", r.ok && r.kind === step.SITE);
  ok("  ... and the overlap is what conflictsAmong reports",
    JSON.stringify(conflictsAmong(["sychord-waves", "clash"], registry)) === '[{"a":"sychord-waves","b":"clash"}]');
}

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
