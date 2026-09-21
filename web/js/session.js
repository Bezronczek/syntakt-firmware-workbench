// The workbench session: one firmware image, an optional official file, and one state object
// per tool -- plus the autosave that makes all of it survive a reload.
//
// DOM free and injectable on purpose: `createSession({ store })` takes any object with the four
// methods of js/store.js, so web/test/session.test.mjs drives exactly this code with an
// in-memory fake. The page never touches the store directly.
//
// Two rules are worth stating out loud:
//   * nothing that comes back from storage is trusted. A restored image is parsed and verified
//     again, from its bytes, by the same code that checked it when it was dropped. A stored image
//     that no longer verifies is dropped, with a message, and the queued changes are kept.
//   * everything persisted is plain structured-clone-able data: bytes as Uint8Array, tool state as
//     arrays/numbers/strings/typed arrays. No parsed objects, no class instances, no DOM.

import * as fwin from "./firmware-input.js";

export const RECORD_KEY = "workbench";
export const RECORD_VERSION = 1;
export const SAVE_DELAY = 300;

const isBytes = (b) => b instanceof Uint8Array && b.length > 0;

/**
 * @param {object} opts
 *   store        required: { get, set, remove, clear, available }
 *   examine      optional override of firmware-input.examine (tests)
 *   examineStock optional override of firmware-input.examineStock (tests)
 *   delay        autosave debounce in ms (default 300)
 */
export function createSession(opts = {}) {
  const store = opts.store;
  const examine = opts.examine || fwin.examine;
  const examineStock = opts.examineStock || fwin.examineStock;
  const delay = opts.delay == null ? SAVE_DELAY : opts.delay;

  const state = { image: null, stock: null, tools: new Map() };
  let timer = null;
  let writing = Promise.resolve();
  let writeFailed = false;

  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(); };

  // ---- persistence -------------------------------------------------------------------

  /** Exactly what goes into the store: no parsed images, no functions, no DOM. */
  function record() {
    return {
      v: RECORD_VERSION,
      image: state.image ? { name: state.image.name, bytes: state.image.bytes } : null,
      stock: state.stock ? { name: state.stock.name, bytes: state.stock.bytes } : null,
      tools: Object.fromEntries(state.tools),
    };
  }

  function scheduleSave() {
    if (!store) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; writeNow(); }, delay);
  }

  function writeNow() {
    const data = record();
    writing = writing.then(
      () => (data.image || data.stock || Object.keys(data.tools).length
        ? store.set(RECORD_KEY, data)
        : store.remove(RECORD_KEY)),
    ).catch(() => { writeFailed = true; });
    return writing;
  }

  /** Force the pending autosave out; the tests and "Forget" await this. */
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; writeNow(); }
    await writing;
  }

  // ---- the image ---------------------------------------------------------------------

  const keep = (r, bytes) => ({
    name: r.name, bytes, size: r.size, hash: r.hash, short: r.short, parsed: r.parsed,
    isStock: !!r.isStock, mods: r.mods || [], modLines: r.modLines || [], headline: r.headline,
  });

  /** Load (or replace) the one image everything is built on. Refused files leave the old one in place. */
  async function setImage(name, bytes) {
    if (!isBytes(bytes)) return { kind: fwin.REFUSED, ok: false, name, reason: "That file is empty.", details: [] };
    const r = await examine(name, bytes);
    if (!r.ok) return r;
    state.image = keep(r, bytes);
    scheduleSave();
    emit();
    return r;
  }

  const bytesOf = (records, name) => {
    const hit = records.find((f) => f.name === name);
    return hit ? hit.bytes : null;
  };

  /**
   * One drop of one or two files, sorted out by what they verify as. Loading both your own image
   * and the official file is recommended, so this accepts them together, in any order.
   * -> the examineDrop result: { image, stock, refused, notes }.
   */
  async function addFiles(records, opts = {}) {
    const usable = records.filter((f) => isBytes(f.bytes));
    const drop = opts.examineDrop || fwin.examineDrop;
    const r = await drop(usable);
    for (const bad of records.filter((f) => !isBytes(f.bytes))) {
      r.refused.push({ ok: false, name: bad.name, headline: bad.name + " was not used",
        reason: "That file is empty or far too small to be a firmware image.", details: [] });
    }
    // the official file dropped on its own is the working image; it is not also kept as a
    // separate reference, because contextFor() already treats a stock image as its own
    if (r.stock && r.stock !== r.image) state.stock = keep(r.stock, bytesOf(usable, r.stock.name));
    if (r.image) state.image = keep(r.image, bytesOf(usable, r.image.name));
    if (r.stock || r.image) { scheduleSave(); emit(); }
    return r;
  }

  /** The optional official file. Only accepted when it really is the stock OS. */
  async function setStock(name, bytes) {
    if (!isBytes(bytes)) return { kind: fwin.REFUSED, ok: false, name, reason: "That file is empty.", details: [] };
    const r = await examineStock(name, bytes);
    if (!r.ok) return r;
    state.stock = keep(r, bytes);
    scheduleSave();
    emit();
    return r;
  }

  function removeStock() {
    state.stock = null;
    scheduleSave();
    emit();
  }

  // ---- tool states -------------------------------------------------------------------

  const getToolState = (id) => state.tools.get(id);

  function setToolState(id, next) {
    if (next == null) state.tools.delete(id);
    else state.tools.set(id, next);
    scheduleSave();
    emit();
  }

  const clearTool = (id) => setToolState(id, null);

  const toolIds = () => [...state.tools.keys()];

  /** Everything a tool is given: the image it edits, the official file if there is one, its mods. */
  function contextFor() {
    return {
      baseParsed: state.image ? state.image.parsed : null,
      // the official file is its own factory reference, so loading it alone is enough for a tool
      // that wants to compare with the factory content
      stockParsed: state.stock ? state.stock.parsed : state.image && state.image.isStock ? state.image.parsed : null,
      present: state.image ? state.image.mods : [],
    };
  }

  // ---- restore and forget --------------------------------------------------------------

  /**
   * Read the stored session back and re-check it.
   * -> { hadRecord, image, droppedImage, droppedStock, toolIds, messages }
   */
  async function restore() {
    const out = { hadRecord: false, image: null, droppedImage: false, droppedStock: false, toolIds: [], messages: [] };
    if (!store) return out;
    let data;
    try {
      data = await store.get(RECORD_KEY);
    } catch {
      out.messages.push("Your browser refused to read the saved session, so this is a fresh start.");
      return out;
    }
    if (!data || typeof data !== "object") return out;
    out.hadRecord = true;

    if (data.v !== RECORD_VERSION) {
      await store.remove(RECORD_KEY).catch(() => {});
      out.messages.push("The saved session was written by an older version of this site and was discarded.");
      return out;
    }

    if (data.tools && typeof data.tools === "object") {
      for (const [id, st] of Object.entries(data.tools)) if (st != null) state.tools.set(id, st);
      out.toolIds = [...state.tools.keys()];
    }

    if (data.image && isBytes(data.image.bytes)) {
      const r = await examine(data.image.name, data.image.bytes);
      if (r.ok) {
        state.image = keep(r, data.image.bytes);
        out.image = r;
      } else {
        out.droppedImage = true;
        out.messages.push("The firmware image saved in this browser no longer checks out (" +
          (r.reason || "it did not verify") + ") and was dropped. Your queued changes are still here: " +
          "load the image again to build.");
      }
    }
    if (data.stock && isBytes(data.stock.bytes)) {
      const r = await examineStock(data.stock.name, data.stock.bytes);
      if (r.ok) state.stock = keep(r, data.stock.bytes);
      else { out.droppedStock = true; out.messages.push("The official file saved in this browser was dropped: " + (r.reason || "it did not verify")); }
    }
    if (out.droppedImage || out.droppedStock) scheduleSave();
    emit();
    return out;
  }

  /** Erase everything, in memory and in the store. */
  async function forget() {
    if (timer) { clearTimeout(timer); timer = null; }
    state.image = null;
    state.stock = null;
    state.tools.clear();
    writeFailed = false;
    if (store) {
      writing = writing.then(() => store.clear()).catch(() => {});
      await writing;
    }
    emit();
  }

  return {
    // reading
    get image() { return state.image; },
    get stock() { return state.stock; },
    get storeAvailable() { return !!store && store.available !== false && !writeFailed; },
    getToolState, toolIds, contextFor,
    // writing
    addFiles, setImage, setStock, removeStock, setToolState, clearTool,
    // lifecycle
    restore, forget, flush,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** The sentence shown after a restore; `queued` is the number of queued change lines. */
export function restoreMessage(result, queued) {
  if (!result.hadRecord) return "";
  const bits = [];
  if (result.image) bits.push("your file");
  if (queued > 0) bits.push(queued + (queued === 1 ? " change" : " changes"));
  if (!bits.length) return result.messages.join(" ");
  return "Welcome back. Loaded from last time: " + bits.join(" and ") + "." +
    (result.messages.length ? " " + result.messages.join(" ") : "");
}
