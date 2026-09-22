// Workbench core: validate any image WITHOUT the stock file, and build one image from the
// queued contributions of several mods. DOM-free; runs in browsers and Node.
//
// How an image is validated without the stock file: js/fingerprints.js holds SHA-256 digests of the
// stock firmware (never its bytes): one per section as it is stored, one per section as the device
// sees it, one per section with every mod region zeroed ("masked"), one per mod region, and one of
// the container shell (header + table, minus the fields a rebuild rewrites).
// An image is acceptable when everything outside the regions of known mods still hashes to the stock
// digests. A region whose digest differs from stock means "that mod is present".
//
// Compressed sections are handled on their decompressed bytes, which is where mod regions live. The
// digest of the stored bytes is only a fast path: when it matches, nothing was touched and nothing
// has to be unpacked. An image whose sections were packed again is not the official file any more
// (isStock is false, `recompressed` is true) but it is a perfectly good base to build on.
//
// Regenerate the digests with  node web/dev/make-fingerprints.mjs  whenever the registry's regions change;
// test/workbench.test.mjs fails if they are stale.

import * as fw from "./syntakt-fw.js";
import { MODS, getMod, containerShell, paddingIsClean, layoutIsRight } from "./mods.js";
import { FINGERPRINTS } from "./fingerprints.js";

export const regionKey = (modId, r) => modId + "|" + r.section + "|" + r.start + "|" + r.end;

/** Stable description of every region in a registry; stored with the digests to detect staleness. */
export function registrySignature(registry = MODS) {
  return registry.flatMap((m) => m.regions.map((r) => regionKey(m.id, r))).sort().join(";");
}

function regionsOfSection(sectionId, registry) {
  return registry.flatMap((m) => m.regions.filter((r) => r.section === sectionId).map((r) => ({ mod: m, r })));
}

function masked(section, regs) {
  const copy = section.slice();
  for (const { r } of regs) copy.fill(0, r.start, r.end);
  return copy;
}

/** Digests of a stock image for a registry. Used by the generator script and by the staleness test. */
export async function computeFingerprints(parsed, registry = MODS) {
  const out = {
    version: parsed.version,
    registry: registrySignature(registry),
    shell: await fw.sha256hex(containerShell(parsed)),
    order: parsed.sections.map((s) => s.id), // the table order, which JSON keys do not keep
    sections: {},
  };
  for (const s of parsed.sections) {
    const stored = fw.getSection(parsed, s.id);
    const compressed = fw.isCompressed(parsed, s.id);
    const bytes = compressed ? fw.getSectionRaw(parsed, s.id) : stored;
    const regs = regionsOfSection(s.id, registry);
    const e = { offset: s.offset, length: s.length, dest: s.dest, sha256: await fw.sha256hex(stored) };
    if (compressed) {
      e.compressed = true;
      e.rawLength = bytes.length;
      e.raw = await fw.sha256hex(bytes);
    }
    if (regs.length) {
      e.masked = await fw.sha256hex(masked(bytes, regs));
      e.regions = {};
      for (const { mod, r } of regs) e.regions[regionKey(mod.id, r)] = await fw.sha256hex(bytes.subarray(r.start, r.end));
    }
    out.sections[s.id] = e;
  }
  return out;
}

/**
 * The container around the sections: the shell must match the stock digest, the gaps and the
 * padding must be zero, and the table must follow the layout rule. Section offsets and the
 * stored lengths of compressed sections are deliberately not compared - a rebuilt image moves
 * them, and the layout rule is what makes that movement legitimate rather than arbitrary.
 */
async function shellProblems(parsed, fp) {
  const out = [];
  const order = fp.order || Object.keys(fp.sections).map(Number);
  if (parsed.sections.map((s) => s.id).join() !== order.join()) {
    out.push({ section: null, reason: "different section table" });
    return out; // the rest of the checks would only describe the same thing again
  }
  if ((await fw.sha256hex(containerShell(parsed))) !== fp.shell) {
    out.push({ section: null, reason: "container header or section table differs (rebuilt by another tool?)" });
  }
  if (!paddingIsClean(parsed)) out.push({ section: null, reason: "container padding differs" });
  if (!layoutIsRight(parsed, Math.min(...order.map((id) => fp.sections[id].offset)))) {
    out.push({ section: null, reason: "the sections do not sit where a rebuilt container puts them" });
  }
  return out;
}

/**
 * Validate a parsed image against the stock digests.
 * -> { ok, isStock, recompressed, mods: [{ id, title, regions: [label] }], unknown: [{ section, reason }] }
 * `isStock` means "byte for byte the official file". An image that only went through the
 * container rebuild has the official content but not the official bytes: `isStock` is false,
 * `recompressed` is true and `mods` is empty.
 */
export async function verifyImage(parsed, registry = MODS, fp = FINGERPRINTS) {
  const unknown = [], found = new Map();
  if (fp.registry !== registrySignature(registry)) throw new Error("fingerprints are stale: run web/dev/make-fingerprints.mjs");
  if (parsed.version !== fp.version) unknown.push({ section: null, reason: "firmware version " + parsed.version + " is not supported" });
  unknown.push(...(await shellProblems(parsed, fp)));
  let isStock = unknown.length === 0;
  let recompressed = false;
  for (const s of parsed.sections) {
    const e = fp.sections[s.id];
    if (!e || e.dest !== s.dest) { unknown.push({ section: s.id, reason: "section moved or resized" }); isStock = false; continue; }
    const stored = fw.getSection(parsed, s.id);
    if (s.length === e.length && (await fw.sha256hex(stored)) === e.sha256) {
      if (s.offset !== e.offset) { recompressed = true; isStock = false; } // pushed along by an earlier section
      continue;
    }
    isStock = false;
    let bytes = stored;
    if (e.compressed) {
      recompressed = true;
      try {
        bytes = fw.getSectionRaw(parsed, s.id);
      } catch (err) {
        unknown.push({ section: s.id, reason: "this part of the file could not be unpacked: " + (err.message || err) });
        continue;
      }
      if (bytes.length !== e.rawLength) { unknown.push({ section: s.id, reason: "section resized" }); continue; }
      if ((await fw.sha256hex(bytes)) === e.raw) continue; // same content, packed differently
    } else if (s.length !== e.length) {
      unknown.push({ section: s.id, reason: "section moved or resized" });
      continue;
    }
    const regs = regionsOfSection(s.id, registry);
    if (!regs.length || (await fw.sha256hex(masked(bytes, regs))) !== e.masked) { unknown.push({ section: s.id, reason: "changes outside every known mod" }); continue; }
    for (const { mod, r } of regs) {
      if ((await fw.sha256hex(bytes.subarray(r.start, r.end))) === e.regions[regionKey(mod.id, r)]) continue;
      const hit = found.get(mod.id) || { id: mod.id, title: mod.title, regions: [] };
      hit.regions.push(r.label);
      found.set(mod.id, hit);
    }
  }
  return { ok: unknown.length === 0, isStock: isStock && unknown.length === 0, recompressed, mods: [...found.values()], unknown };
}

/** Mods queued or present that collide with each other: [{ a, b }] (ids). Empty = fine. */
export function conflictsAmong(ids, registry = MODS) {
  const out = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const A = getMod(ids[i], registry), B = getMod(ids[j], registry);
      if (A.regions.some((ra) => B.regions.some((rb) => ra.section === rb.section && ra.start < rb.end && rb.start < ra.end))) out.push({ a: A.id, b: B.id });
    }
  return out;
}

/**
 * Build one image from a base image and the queued contributions.
 * contributions: [{ modId, section, bytes }] where `bytes` is the mod's full rewritten copy of that
 * section AS THE DEVICE SEES IT: decompressed bytes for a compressed section, and always exactly as
 * long as the section it replaces.
 * Only bytes inside the mod's own regions are taken from a contribution, so several mods can share a section
 * and a buggy mod cannot write outside its declaration (it is reported instead).
 * `options.level` is the aPLib effort used for compressed sections; 3 is the default because it is
 * the only level proven to reproduce the chain that was flashed on hardware. Lower levels are much
 * faster and are what the tests use where the bytes of the packed stream do not matter.
 * A compressed section almost never packs back to the same length, so THE OUTPUT MAY CHANGE SIZE;
 * the report says what it was and what it became.
 * -> { file, parsed, report: { mods, strayWrites: [{ modId, section, count }], sizeBefore, sizeAfter } }
 * Throws if the result does not verify.
 */
export async function buildImage(baseParsed, contributions, registry = MODS, fp = FINGERPRINTS, options = {}) {
  const level = options.level == null ? 3 : options.level;
  // options.onProgress({ phase: "pack", section, fraction }) reports the slow part: packing a
  // compressed section. fraction runs 0..1 over all compressed sections being written.
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const before = await verifyImage(baseParsed, registry, fp);
  if (!before.ok) throw new Error("the base image does not verify: " + before.unknown.map((u) => u.reason).join("; "));
  const queued = [...new Set(contributions.map((c) => c.modId))];
  const clash = conflictsAmong([...new Set([...before.mods.map((m) => m.id), ...queued])], registry);
  if (clash.length) throw new Error("conflicting mods: " + clash.map((c) => c.a + " + " + c.b).join(", "));

  const strayWrites = [];
  const sections = new Map();
  const originals = new Map(); // one depack per section, however many mods contribute to it
  const originalOf = (id) => {
    if (!originals.has(id)) originals.set(id, fw.getSectionRaw(baseParsed, id));
    return originals.get(id);
  };
  for (const c of contributions) {
    const original = originalOf(c.section);
    const base = sections.get(c.section) || original;
    if (c.bytes.length !== base.length) throw new Error(c.modId + ": section " + c.section + " changed size");
    const mine = getMod(c.modId, registry).regions.filter((r) => r.section === c.section);
    if (!mine.length) throw new Error(c.modId + " declares no region in section " + c.section);
    const next = base.slice();
    for (const r of mine) next.set(c.bytes.subarray(r.start, r.end), r.start);
    let stray = 0;
    for (let i = 0; i < next.length; i++) if (c.bytes[i] !== original[i] && !mine.some((r) => i >= r.start && i < r.end)) stray++;
    if (stray) strayWrites.push({ modId: c.modId, section: c.section, count: stray });
    sections.set(c.section, next);
  }
  // A raw section is patched in place, which keeps every other byte of the transport where it
  // was; a compressed one goes through the container rebuild, which moves everything after it.
  let parsed = baseParsed;
  const packed = [...sections.keys()].filter((id) => fw.isCompressed(baseParsed, id));
  let done = 0;
  for (const [id, bytes] of sections) {
    if (fw.isCompressed(parsed, id)) {
      const k = done++;
      const report = onProgress && ((f) => onProgress({ phase: "pack", section: id, fraction: (k + f) / packed.length }));
      parsed = fw.replaceSection(parsed, id, bytes, { level, onProgress: report });
    } else {
      parsed = fw.parseSyx(fw.replaceRawSection(parsed, id, bytes));
    }
  }
  const file = parsed.file;

  const after = await verifyImage(parsed, registry, fp);
  const allowed = new Set([...before.mods.map((m) => m.id), ...queued]);
  const extra = after.mods.filter((m) => !allowed.has(m.id));
  if (!after.ok || extra.length) throw new Error("the built image failed verification");
  return { file, parsed, report: { mods: after.mods, strayWrites, sizeBefore: baseParsed.file.length, sizeAfter: file.length } };
}
