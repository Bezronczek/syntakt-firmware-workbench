// Mod registry + compatibility engine, shared by every tool on the site.
//
// A mod declares the byte regions it may write, as [start, end) offsets inside a firmware
// section. The rules, deliberately the weakest useful guarantee:
//   * two mods may be combined only if their regions are disjoint;
//   * an image may differ from the stock file only inside regions of known mods;
//   * no mod changes the length of a section's CONTENT, so every offset stays put.
// Disjoint bytes mean the mods cannot corrupt each other. It does NOT mean they make sense
// together; say so in the UI.
//
// Compressed sections are first-class: every offset a mod declares is an offset into the
// section as the device sees it (decompressed), and a section is always compared on those
// bytes. What a compressed section costs when it is stored is not a mod's business: a
// rebuilt image packs to a different length, so the sections after it move and the file
// changes size. The container is therefore compared structurally (see containerShell).

import * as fw from "./syntakt-fw.js";
import { BLOCK_REGION, OPERANDS } from "./sychord-picture-map.js";
import * as lfoDv from "./lfo-dv.js";

export const MODS = [
  {
    id: "sychord-waves",
    title: "SY CHORD Wave Bank",
    page: "sychord-waves.html",
    summary: "Put your own waves into the SY CHORD machine. You pick them with its WAVE knob, as before.",
    // Optional, for the hub page only; the engine above ignores these.
    status: "available",
    touches: "Changes SY CHORD, and the wave pictures its screen draws. If you choose to, also the sine at WAVE 0, which other machines use too.",
    // The same template for every tool: a badge, a few facts shown on the card, the rest under "More about this tool".
    about: {
      badge: "Confirmed on hardware",
      facts: [
        ["Waves", "31 you can change (WAVE 4, 8, 12 ... 124). The values in between morph from one wave to the next."],
        ["Your files", "Single-cycle WAV files of any length, 8 to 32 bit, mono or stereo (left channel is used)."],
        ["Chords", "Make a wave that holds a whole chord: major, minor, sevenths, ninths and more, in any inversion."],
        ["Whole banks", "Drop a WaftWave bank (.json) or a ZIP of WAV files to fill many waves at once."],
        ["Done for you", "Resized to one cycle of 256 points, centred, set to full level, lined up to start at zero, and limited in brightness."],
        ["Two ways", "Replace one wave, or insert a wave: the waves above move up one step and the last one drops off."],
        ["On the screen", "The little wave picture in the WAVE cell is redrawn to match your waves. Checked on a real Syntakt."],
      ],
      more: [
        ["Tested on a real Syntakt",
         "A saw and a square wave were built with this tool, flashed onto a Syntakt running OS 1.41 and measured from its audio output. " +
         "Both came out within 1% of the waves that went in, over 40 harmonics. Every WAVE value that was left alone measured exactly as before. " +
         "Adding a second change to an already changed file was tested the same way."],
        ["What it changes in the firmware",
         "The wave tables of SY CHORD, and - if you leave that switched on - the 128 small wave pictures the screen draws for the " +
         "WAVE knob, plus three small pointers that pick a picture for three of the WAVE values. No program instructions, no other machine. " +
         "Before you can download, the site checks that your new file differs from " +
         "the official one in those bytes only."],
        ["The picture on the screen",
         "Checked on a real Syntakt on 22 September 2026: a square, a triangle, a saw and a pulse put at WAVE 4, 8, 12 and 124 were " +
         "drawn as those shapes, the values in between morphed, and untouched values kept their original pictures. If you would rather " +
         "not have it, switch off \"Draw my waves on the Syntakt screen too\" in Settings; then only the waves change, exactly as before."],
        ["Chord waves",
         "One wave can only hold whole-number multiples of the note you play, so the chord sounds high: with \"Root on the note " +
         "you play\" its root is four octaves above your note, and a few notes are up to about 30 cents off pure tuning. " +
         "\"Pure intervals\" tunes every interval exactly, but the root is then not always an octave of your note; the tool says " +
         "where it lands. Lower TUNE to bring the chord down. Checked on a real Syntakt on 23 September 2026."],
        ["WaftWave banks",
         "WaftWave (wftlrd.uk/waftwave) exports a bank of up to 64 waves as .json, or as a ZIP of WAV files. Both can be dropped " +
         "on a wave here. When the bank has more waves than fit, you choose: spread them evenly so the whole sweep fits, " +
         "or take the first ones. Checked on a real Syntakt on 23 September 2026."],
        ["What stays the same",
         "All other machines are untouched, and so is everything else on the screen."],
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
    // Section 7 holds the waves themselves; section 3 (compressed: the offsets below are into
    // its decompressed bytes) holds the 128 pictures the screen draws and the three pointers
    // that pick a picture for the WAVE values which do not own one.
    regions: [
      { section: 7, start: fw.WAVE.BANK_END - fw.WAVE.FRAMES * fw.WAVE.STEP, end: fw.WAVE.BANK_END, label: "wave bank, frames 1-31" },
      { section: 7, start: fw.WAVE.SINE_OFF, end: fw.WAVE.SINE_OFF + fw.WAVE.SAMPLES * 4, label: "frame 0, the sine shared with other machines", optional: true },
      { section: 3, start: BLOCK_REGION.start, end: BLOCK_REGION.end, label: "wave pictures on the screen", optional: true },
      ...OPERANDS.map((o) => ({ section: 3, start: o.pointer, end: o.pointer + 4, label: "picture pointer for WAVE " + o.value, optional: true })),
    ],
  },
  {
    id: "lfo-dv",
    title: "Deja Vu LFO",
    summary: "Two new LFO shapes, DV-F and DV-T: a loop of random steps you can lock, vary or shuffle with SPH. " +
      "The behaviour is inspired by the Deja Vu control of Mutable Instruments Marbles.",
    status: "available",
    touches: "Changes the LFO of every track: two shapes are added after RND, and SPH and MODE work differently for them. The seven original shapes are unchanged.",
    about: {
      badge: "Confirmed on hardware",
      facts: [
        ["Shapes", "DV-F keeps running on its own. DV-T starts the loop again on every note."],
        ["Inspired by", "The Deja Vu control of Mutable Instruments Marbles: random values that can repeat, change or be reshuffled."],
        ["SPH", "0: new values all the time. 64: the loop repeats. 127: the same values in a new order."],
        ["MODE", "Length of the loop: 2, 4, 8, 16 or 32 steps. The MODE cell shows the number."],
      ],
      more: [
        ["Tested on a real Syntakt",
         "Built with the same code as this page, flashed onto a Syntakt running OS 1.41 on 23 September 2026 and checked on its screen and by ear: " +
         "every loop length, SPH 0, 64 and 127, DV-T restarting on notes, both LFOs of a track and several tracks."],
        ["Your existing sounds",
         "Sounds that use one of the seven original shapes do not change. A sound saved with DV-F or DV-T plays a different shape on the official firmware."],
        ["Only OS 1.41", "Other OS versions are refused."],
        ["Using it with other tools", "It can be combined with any tool that does not change the same bytes. The site checks this before you start."],
      ],
    },
    regions: lfoDv.REGIONS.map((r) => ({ section: lfoDv.SECTION, start: r.start, end: r.end, label: r.label })),
},
];

// ---- the container around the sections ------------------------------------------------
//
// ELE3 geometry, as syntakt-fw.js writes it: a section count word, then 16-byte table
// entries of [id][offset][length][dest].

const TABLE_OFF = 0x20, ENTRY = 16, ALIGN = 16;

const firstOffsetOf = (parsed) => Math.min(...parsed.sections.map((s) => s.offset));

/**
 * The part of the container that must be identical in every image the site accepts:
 * everything before the first section payload, with each table entry's offset and length
 * field zeroed. Those two fields are the only header bytes a rebuild rewrites (see
 * rebuildContainer in syntakt-fw.js), so an image whose compressed sections were packed
 * again - and therefore moved - still has the same shell as the official file.
 */
export function containerShell(parsed) {
  const first = firstOffsetOf(parsed);
  const shell = parsed.container.slice(0, first);
  for (let i = 0; i < parsed.sections.length; i++) {
    const t = TABLE_OFF + i * ENTRY;
    if (t + 12 <= shell.length) shell.fill(0, t + 4, t + 12);
  }
  return shell;
}

/** Every byte of the container that is not part of a section (alignment gaps, final padding) is zero. */
export function paddingIsClean(parsed) {
  const mask = new Uint8Array(parsed.container.length);
  for (const s of parsed.sections) mask.fill(1, s.offset, s.offset + s.length);
  for (let i = firstOffsetOf(parsed); i < mask.length; i++) if (!mask[i] && parsed.container[i] !== 0) return false;
  return true;
}

/** The layout rule a rebuilt container follows: offset order, each section 16-byte aligned, padded end. */
export function layoutIsRight(parsed, firstOffset = firstOffsetOf(parsed)) {
  if (firstOffsetOf(parsed) !== firstOffset) return false;
  const order = parsed.sections.slice().sort((a, b) => a.offset - b.offset);
  let pos = firstOffset;
  for (const s of order) {
    pos += (ALIGN - (pos % ALIGN)) % ALIGN;
    if (s.offset !== pos) return false;
    pos += s.length;
  }
  return parsed.container.length === pos + ((ALIGN - (pos % ALIGN)) % ALIGN);
}

/** A section as the device sees it: decompressed when it is stored compressed. */
export const sectionContent = (parsed, id) => fw.getSectionRaw(parsed, id);

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
    if (s.id !== t.id || s.dest !== t.dest) {
      unknown.push({ section: s.id, start: 0, end: s.length, reason: "the section table was rewritten" });
      continue;
    }
    // A compressed section is compared on its decompressed bytes: where it sits and how long
    // it is when packed says nothing about its content.
    let a, b;
    try {
      a = sectionContent(stock, s.id);
      b = sectionContent(image, s.id);
    } catch (err) {
      unknown.push({ section: s.id, start: 0, end: s.length, reason: "this section could not be read: " + (err.message || err) });
      continue;
    }
    if (a.length !== b.length) {
      unknown.push({ section: s.id, start: 0, end: Math.max(a.length, b.length), reason: "section resized" });
      continue;
    }
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
  // Everything outside the section payloads: the header and the table must match apart from
  // the offset/length fields a rebuild rewrites, the gaps and the padding must be zero, and
  // the table must follow the layout rule - so a section can only have moved because an
  // earlier one packed to a different length.
  if (fw.diffRange(containerShell(stock), containerShell(image)) !== null) {
    unknown.push({ section: null, start: 0, end: 0, reason: "container header or section table differs" });
  }
  if (!paddingIsClean(image)) unknown.push({ section: null, start: 0, end: 0, reason: "container padding differs" });
  if (!layoutIsRight(image, Math.min(...stock.sections.map((s) => s.offset)))) {
    unknown.push({ section: null, start: 0, end: 0, reason: "the sections do not sit where a rebuilt container puts them" });
  }
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
