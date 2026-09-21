// Mod registry + compatibility engine, shared by every tool on the site.
//
// A mod declares the byte regions it may write, as [start, end) offsets inside a firmware
// section. The rules, deliberately the weakest useful guarantee:
//   * two mods may be combined only if their regions are disjoint;
//   * an image may differ from the stock file only inside regions of known mods;
//   * no mod changes the length of a section, so every offset stays put.
// Disjoint bytes mean the mods cannot corrupt each other. It does NOT mean they make sense
// together; say so in the UI.
//
// Current limitation: only raw (uncompressed) sections can be compared or written, because
// the site has no aPLib codec yet. An image whose compressed sections differ from stock is
// reported as unknown and refused.

import * as fw from "./syntakt-fw.js";

export const MODS = [
  {
    id: "sychord-waves",
    title: "SY CHORD Wave Bank",
    page: "sychord-waves.html",
    summary: "Put your own waves into the SY CHORD machine. You pick them with its WAVE knob, as before.",
    // Optional, for the hub page only; the engine above ignores these.
    status: "available",
    touches: "Changes SY CHORD only. If you choose to, also the sine at WAVE 0, which other machines use too.",
    // The same template for every tool: a badge, a few facts shown on the card, the rest under "More about this tool".
    about: {
      badge: "Confirmed on hardware",
      facts: [
        ["Waves", "31 you can change (WAVE 4, 8, 12 ... 124). The values in between morph from one wave to the next."],
        ["Your files", "Single-cycle WAV files of any length, 8 to 32 bit, mono or stereo (left channel is used)."],
        ["Done for you", "Resized to one cycle of 256 points, centred, set to full level, lined up to start at zero, and limited in brightness."],
        ["Two ways", "Replace one wave, or insert a wave: the waves above move up one step and the last one drops off."],
      ],
      more: [
        ["Tested on a real Syntakt",
         "A saw and a square wave were built with this tool, flashed onto a Syntakt running OS 1.41 and measured from its audio output. " +
         "Both came out within 1% of the waves that went in, over 40 harmonics. Every WAVE value that was left alone measured exactly as before. " +
         "Adding a second change to an already changed file was tested the same way."],
        ["What it changes in the firmware",
         "Only the wave tables of SY CHORD, inside the part of the firmware that holds sound data. No program code, no sizes, nothing else. " +
         "Before you can download, the site checks that your new file differs from the official one in those bytes only."],
        ["What stays the same",
         "The small wave picture on the Syntakt screen still shows the original shape. The sound is yours, the picture is not. " +
         "All other machines are untouched."],
        ["WAVE 0 is special",
         "WAVE 0 is a sine that other machines also use. It is locked. If you unlock and change it, those machines change too."],
        ["Bright waves and high notes",
         "SY CHORD keeps one copy of each wave for all notes, so very bright waves sound harsh on high notes. " +
         "The original waves are mellow for that reason. New waves are limited to 40 harmonics, and you can lower that for each wave."],
        ["Your existing sounds",
         "Patterns and sounds that use a WAVE value you changed, or one next to it, will sound different. Flash the official file to get everything back."],
        ["Only OS 1.41",
         "Where the waves sit in the firmware was found by measuring, not from any documentation. Another OS version can move them, so other versions are refused."],
        ["Using it with other tools", "It can be combined with any tool that does not change the same bytes. The site checks this before you start."],
      ],
    },
    regions: [
      { section: 7, start: fw.WAVE.BANK_END - fw.WAVE.FRAMES * fw.WAVE.STEP, end: fw.WAVE.BANK_END, label: "wave bank, frames 1-31" },
      { section: 7, start: fw.WAVE.SINE_OFF, end: fw.WAVE.SINE_OFF + fw.WAVE.SAMPLES * 4, label: "frame 0, the sine shared with other machines", optional: true },
    ],
  },
];

export function getMod(id, registry = MODS) {
  const m = registry.find((x) => x.id === id);
  if (!m) throw new Error("unknown mod: " + id);
  return m;
}

const overlaps = (a, b) => a.section === b.section && a.start < b.end && b.start < a.end;

/** Region pairs in which two mods collide; empty array = combinable. */
export function conflictsBetween(a, b) {
  const out = [];
  for (const ra of a.regions) for (const rb of b.regions) if (overlaps(ra, rb)) out.push({ a: ra, b: rb });
  return out;
}

/** Every colliding pair in a registry: run by the tests so a new mod cannot silently overlap an old one. */
export function registryConflicts(registry = MODS) {
  const out = [];
  for (let i = 0; i < registry.length; i++)
    for (let j = i + 1; j < registry.length; j++) {
      const c = conflictsBetween(registry[i], registry[j]);
      if (c.length) out.push({ a: registry[i].id, b: registry[j].id, regions: c });
    }
  return out;
}

/** Maximal runs of differing bytes between two equal-length arrays, as [start, end). */
export function diffRuns(a, b) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { if (start < 0) start = i; }
    else if (start >= 0) { runs.push([start, i]); start = -1; }
  }
  if (start >= 0) runs.push([start, a.length]);
  return runs;
}

/**
 * What does `image` contain relative to `stock` (both results of fw.parseSyx)?
 * -> { mods: [{ id, title, bytesChanged, regions: [label...] }], unknown: [{ section, start, end, reason }] }
 * `unknown` non-empty means the image must be refused.
 */
export function analyseImage(stock, image, registry = MODS) {
  const found = new Map();
  const unknown = [];
  if (stock.sections.length !== image.sections.length) {
    return { mods: [], unknown: [{ section: null, start: 0, end: 0, reason: "different section table" }] };
  }
  for (let i = 0; i < stock.sections.length; i++) {
    const s = stock.sections[i], t = image.sections[i];
    if (s.id !== t.id || s.offset !== t.offset || s.length !== t.length || s.dest !== t.dest) {
      unknown.push({ section: s.id, start: 0, end: s.length, reason: "section moved or resized (recompressed?)" });
      continue;
    }
    const a = fw.getSection(stock, s.id), b = fw.getSection(image, s.id);
    for (const [start, end] of diffRuns(a, b)) {
      // a run may span several regions of one mod but every byte must belong to some region
      let pos = start;
      while (pos < end) {
        let hit = null;
        for (const m of registry) for (const r of m.regions) if (r.section === s.id && pos >= r.start && pos < r.end) hit = { m, r };
        if (!hit) {
          let stop = pos + 1;
          while (stop < end && !registry.some((m) => m.regions.some((r) => r.section === s.id && stop >= r.start && stop < r.end))) stop++;
          unknown.push({ section: s.id, start: pos, end: stop, reason: "bytes outside every known mod" });
          pos = stop;
          continue;
        }
        const stop = Math.min(end, hit.r.end);
        const e = found.get(hit.m.id) || { id: hit.m.id, title: hit.m.title, bytesChanged: 0, regions: new Set() };
        for (let k = pos; k < stop; k++) if (a[k] !== b[k]) e.bytesChanged++;
        e.regions.add(hit.r.label);
        found.set(hit.m.id, e);
        pos = stop;
      }
    }
  }
  // anything outside the section payloads (header, table, padding) must be identical
  const mask = new Uint8Array(stock.container.length);
  for (const s of stock.sections) mask.fill(1, s.offset, s.offset + s.length);
  if (stock.container.length !== image.container.length) unknown.push({ section: null, start: 0, end: 0, reason: "container size differs" });
  else for (let i = 0; i < mask.length; i++) if (!mask[i] && stock.container[i] !== image.container[i]) { unknown.push({ section: null, start: i, end: i + 1, reason: "container header or padding differs" }); break; }
  return { mods: [...found.values()].map((e) => ({ ...e, regions: [...e.regions] })), unknown };
}

/** Can the tool `modId` be applied on top of an image that already contains `presentIds`? */
export function checkCompatible(modId, presentIds, registry = MODS) {
  const me = getMod(modId, registry);
  const conflicts = [];
  for (const id of presentIds) {
    if (id === modId) continue; // re-editing your own mod is always fine
    const c = conflictsBetween(me, getMod(id, registry));
    if (c.length) conflicts.push({ with: id, title: getMod(id, registry).title, regions: c });
  }
  return { ok: conflicts.length === 0, conflicts };
}

/**
 * Final gate before offering a download: `out` must differ from `stock` only inside regions of
 * the mods in `allowedIds`. -> { ok, mods, unknown, notAllowed }
 */
export function verifyAgainstStock(stock, out, allowedIds, registry = MODS) {
  const r = analyseImage(stock, out, registry);
  const notAllowed = r.mods.filter((m) => !allowedIds.includes(m.id)).map((m) => m.id);
  return { ok: r.unknown.length === 0 && notAllowed.length === 0, ...r, notAllowed };
}
