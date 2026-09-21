// Workbench core: validate any image WITHOUT the stock file, and build one image from the
// queued contributions of several mods. DOM-free; runs in browsers and Node.
//
// How an image is validated without the stock file: js/fingerprints.js holds SHA-256 digests of the
// stock firmware (never its bytes): one per section, one per section with every mod region zeroed
// ("masked"), one per mod region, and one of the container with all section payloads zeroed.
// An image is acceptable when everything outside the regions of known mods still hashes to the stock
// digests. A region whose digest differs from stock means "that mod is present".
//
// Regenerate the digests with  node web/dev/make-fingerprints.mjs  whenever the registry's regions change;
// test/workbench.test.mjs fails if they are stale.

import * as fw from "./syntakt-fw.js";
import { MODS, getMod } from "./mods.js";
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

function containerShell(parsed) {
  const shell = parsed.container.slice();
  for (const s of parsed.sections) shell.fill(0, s.offset, s.offset + s.length);
  return shell;
}

/** Digests of a stock image for a registry. Used by the generator script and by the staleness test. */
export async function computeFingerprints(parsed, registry = MODS) {
  const out = { version: parsed.version, registry: registrySignature(registry), shell: await fw.sha256hex(containerShell(parsed)), sections: {} };
  for (const s of parsed.sections) {
    const bytes = fw.getSection(parsed, s.id), regs = regionsOfSection(s.id, registry);
    const e = { offset: s.offset, length: s.length, dest: s.dest, sha256: await fw.sha256hex(bytes) };
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
 * Validate a parsed image against the stock digests.
 * -> { ok, isStock, mods: [{ id, title, regions: [label] }], unknown: [{ section, reason }] }
 */
export async function verifyImage(parsed, registry = MODS, fp = FINGERPRINTS) {
  const unknown = [], found = new Map();
  if (fp.registry !== registrySignature(registry)) throw new Error("fingerprints are stale: run web/dev/make-fingerprints.mjs");
  if (parsed.version !== fp.version) unknown.push({ section: null, reason: "firmware version " + parsed.version + " is not supported" });
  if (parsed.sections.length !== Object.keys(fp.sections).length) unknown.push({ section: null, reason: "different section table" });
  if ((await fw.sha256hex(containerShell(parsed))) !== fp.shell) unknown.push({ section: null, reason: "container header, section table or padding differs (rebuilt by another tool?)" });
  let isStock = unknown.length === 0;
  for (const s of parsed.sections) {
    const e = fp.sections[s.id];
    if (!e || e.offset !== s.offset || e.length !== s.length || e.dest !== s.dest) { unknown.push({ section: s.id, reason: "section moved or resized" }); isStock = false; continue; }
    const bytes = fw.getSection(parsed, s.id);
    if ((await fw.sha256hex(bytes)) === e.sha256) continue;
    isStock = false;
    const regs = regionsOfSection(s.id, registry);
    if (!regs.length || (await fw.sha256hex(masked(bytes, regs))) !== e.masked) { unknown.push({ section: s.id, reason: "changes outside every known mod" }); continue; }
    for (const { mod, r } of regs) {
      if ((await fw.sha256hex(bytes.subarray(r.start, r.end))) === e.regions[regionKey(mod.id, r)]) continue;
      const hit = found.get(mod.id) || { id: mod.id, title: mod.title, regions: [] };
      hit.regions.push(r.label);
      found.set(mod.id, hit);
    }
  }
  return { ok: unknown.length === 0, isStock: isStock && unknown.length === 0, mods: [...found.values()], unknown };
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
 * contributions: [{ modId, section, bytes }] where `bytes` is the mod's full rewritten copy of that section.
 * Only bytes inside the mod's own regions are taken from a contribution, so several mods can share a section
 * and a buggy mod cannot write outside its declaration (it is reported instead).
 * -> { file, parsed, report: { mods, strayWrites: [{ modId, section, count }] } }   Throws if the result does not verify.
 */
export async function buildImage(baseParsed, contributions, registry = MODS, fp = FINGERPRINTS) {
  const before = await verifyImage(baseParsed, registry, fp);
  if (!before.ok) throw new Error("the base image does not verify: " + before.unknown.map((u) => u.reason).join("; "));
  const queued = [...new Set(contributions.map((c) => c.modId))];
  const clash = conflictsAmong([...new Set([...before.mods.map((m) => m.id), ...queued])], registry);
  if (clash.length) throw new Error("conflicting mods: " + clash.map((c) => c.a + " + " + c.b).join(", "));

  const strayWrites = [];
  const sections = new Map();
  for (const c of contributions) {
    const base = sections.get(c.section) || fw.getSection(baseParsed, c.section);
    if (c.bytes.length !== base.length) throw new Error(c.modId + ": section " + c.section + " changed size");
    const mine = getMod(c.modId, registry).regions.filter((r) => r.section === c.section);
    if (!mine.length) throw new Error(c.modId + " declares no region in section " + c.section);
    const next = base.slice();
    for (const r of mine) next.set(c.bytes.subarray(r.start, r.end), r.start);
    let stray = 0;
    const original = fw.getSection(baseParsed, c.section);
    for (let i = 0; i < next.length; i++) if (c.bytes[i] !== original[i] && !mine.some((r) => i >= r.start && i < r.end)) stray++;
    if (stray) strayWrites.push({ modId: c.modId, section: c.section, count: stray });
    sections.set(c.section, next);
  }
  let parsed = baseParsed, file = baseParsed.file;
  for (const [id, bytes] of sections) { file = fw.replaceRawSection(parsed, id, bytes); parsed = fw.parseSyx(file); }

  const after = await verifyImage(parsed, registry, fp);
  const allowed = new Set([...before.mods.map((m) => m.id), ...queued]);
  const extra = after.mods.filter((m) => !allowed.has(m.id));
  if (!after.ok || extra.length) throw new Error("the built image failed verification");
  if (file.length !== baseParsed.file.length) throw new Error("the built image changed size");
  return { file, parsed, report: { mods: after.mods, strayWrites } };
}
