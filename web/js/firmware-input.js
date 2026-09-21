// "Your firmware image", step 1 of the workbench: ONE file, and no stock file required.
//
// The file is either the official Syntakt OS 1.41, or an image built on this site earlier.
// Which one it is, and whether it can be trusted, is decided by workbench.verifyImage(),
// which compares the image against SHA-256 digests of the stock firmware rather than against
// the stock bytes -- so a user who only has their own modified image can still work.
//
// This module is DOM free and I/O free: it takes { name, bytes } and returns plain data plus
// the sentences the page should show, which is what makes it testable in Node
// (see web/test/firmware-input.test.mjs). The page only renders what it returns.

import * as fw from "./syntakt-fw.js";
import { MODS } from "./mods.js";
import { verifyImage } from "./workbench.js";
import { FINGERPRINTS } from "./fingerprints.js";

/** Accepted kinds. "refused" carries `reason` and `details` instead of a parsed image. */
export const STOCK = "stock";
export const SITE = "site";
export const REFUSED = "refused";

const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

/** Primary text: the name of the tool's mod, nothing technical. */
export function describeMod(m) {
  return m.title;
}

/** The same mod for a "Details" block: which parts of the firmware it changed. */
export function describeModDetail(m) {
  return m.title + (m.regions && m.regions.length ? " - " + m.regions.join(", ") : "");
}

/** Readable lines for whatever verifyImage could not account for. */
export function describeUnknown(unknown) {
  return unknown.map((u) => (u.section === null ? "container" : "section " + u.section) + ": " + u.reason);
}

/** First 12 hex digits: enough to recognise a file again, short enough to read out. */
export const shortHash = (hash) => hash.slice(0, 12);

/**
 * Look at one dropped file.
 * -> { kind, ok, name, size, hash, short, parsed?, mods?, modLines?, isStock?, headline, reason?, details? }
 * Never throws: a damaged file comes back as `refused` with a readable reason.
 */
export async function examine(name, bytes, opts = {}) {
  const registry = opts.registry || MODS;
  const fingerprints = opts.fingerprints || FINGERPRINTS;
  const base = { name, size: bytes ? bytes.length : 0 };

  if (!(bytes instanceof Uint8Array) || bytes.length < 16) {
    return { ...base, kind: REFUSED, ok: false, headline: "This file is empty",
      reason: "Choose the Syntakt firmware file you downloaded from Elektron.",
      details: [name + ": " + base.size + " bytes"] };
  }
  const hash = await fw.sha256hex(bytes);
  const short = shortHash(hash);

  let parsed;
  try {
    parsed = fw.parseSyx(bytes);
  } catch (err) {
    return { ...base, kind: REFUSED, ok: false, hash, short,
      headline: "This file is damaged, or is not Syntakt firmware",
      reason: "Download the firmware again from elektron.se and try once more.",
      details: ["the file could not be decoded: " + (err.message || err)] };
  }

  let v;
  try {
    v = await verifyImage(parsed, registry, fingerprints);
  } catch (err) {
    return { ...base, kind: REFUSED, ok: false, hash, short, headline: "This file could not be checked",
      reason: "Something is wrong with this copy of the site. Reload the page and try again.",
      details: [String(err.message || err)] };
  }

  if (!v.ok) {
    return { ...base, kind: REFUSED, ok: false, hash, short, parsed: null,
      headline: "This file was changed by something else",
      reason: "Load the official Syntakt OS 1.41 file, or a file this site built for you.",
      details: describeUnknown(v.unknown) };
  }

  const modLines = v.mods.map(describeMod);
  const modDetails = v.mods.map(describeModDetail);
  if (v.isStock) {
    return { ...base, kind: STOCK, ok: true, hash, short, parsed, isStock: true,
      mods: [], modLines: [], modDetails: [], headline: "Official Syntakt firmware, OS 1.41" };
  }
  return { ...base, kind: SITE, ok: true, hash, short, parsed, isStock: false, mods: v.mods, modLines, modDetails,
    headline: modLines.length ? "Your image, with " + modLines.join(" and ") : "Your image, with nothing changed yet" };
}

/**
 * The optional second file: it is only useful when it really is the official one, because its
 * only job is to give tools the factory bytes back.
 */
export async function examineStock(name, bytes, opts = {}) {
  const r = await examine(name, bytes, opts);
  if (r.kind === STOCK) return r;
  return { ...r, kind: REFUSED, ok: false, parsed: null,
    headline: r.kind === SITE ? "That is your own image, not the official file" : r.headline,
    reason: r.kind === SITE
      ? "Add the untouched Syntakt_OS1.41.syx you downloaded from Elektron."
      : r.reason,
    details: r.details || [] };
}

/**
 * Sort out one drop of one or two files, in any order.
 *   * the official file becomes the stock reference,
 *   * an image built here becomes the working image,
 *   * with both, the site image is what the tools edit and the official file is the reference,
 *   * with the official file alone it is both (it is its own factory content).
 * -> { image, stock, refused: [...], notes: [string] }  (`image`/`stock` are examine results or null)
 */
export async function examineDrop(records, opts = {}) {
  const out = { image: null, stock: null, refused: [], notes: [] };
  const seen = [];
  for (const rec of records) {
    const r = await examine(rec.name, rec.bytes, opts);
    if (!r.ok) { out.refused.push(r); continue; }
    seen.push(r);
  }
  for (const r of seen) {
    if (r.kind === STOCK) {
      if (out.stock) { out.notes.push("You added the official file twice; the first one is used."); continue; }
      out.stock = r;
    } else {
      if (out.image) { out.notes.push(r.name + " was ignored. You can work on one image at a time."); continue; }
      out.image = r;
    }
  }
  if (!out.image && out.stock) out.image = out.stock; // the official file is its own factory reference
  return out;
}

/** The recommendation to add the official file as well: { show, have, text }. */
export function stockAdvice(image, stock) {
  if (!image) return { show: false, have: false, text: "" };
  if (stock) {
    return { show: true, have: true,
      text: "Official file added. Tools can now show what is changed and put the original sounds back." };
  }
  if (image.isStock) return { show: false, have: true, text: "" };
  return { show: true, have: false,
    text: "Recommended: add the official firmware file too. Then a tool can show what is already changed " +
      "in your image, and put the original sounds back. You can build without it." };
}

/** Primary text: a size a person reads at a glance. */
export function describeSize(n) {
  return (n / 1048576).toFixed(1) + " MB";
}

/** The same size for a "Details" block, to the byte. */
export function describeSizeExact(n) {
  return plural(n, "byte", "bytes");
}

/** One line naming the file a tool is working on. */
export function describeImage(image) {
  if (!image) return "No file loaded.";
  return "Working on " + image.name + ".";
}
