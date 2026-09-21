// Tests for the workbench session: autosave, restore, re-verification and Forget.
// The store is the in-memory fake from js/store.js, which clones exactly like IndexedDB does,
// so anything that would not survive a real save fails here too.
// Needs the (never committed) firmware files in work/. Run from the project root:
//   node web/test/session.test.mjs
import { readFileSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";
import * as bank from "../js/bank.js";
import { createMemoryStore, STORE_NAME } from "../js/store.js";
import { createSession, restoreMessage, RECORD_KEY } from "../js/session.js";
import { tool } from "../js/tools/sychord-waves.js";

let fails = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
  if (!cond) fails++;
};
const rd = (p) => new Uint8Array(readFileSync(p));
const same = (a, b) => fw.diffRange(a, b) === null;

const STOCK = "work/Syntakt_OS1.41.syx";
const SAW = "work/syntakt141_sychord_saw30.syx";
const EXP = "work/EXPERIMENT_frame0.syx";
const stockBytes = rd(STOCK);
const sawBytes = rd(SAW);

const saw = Float64Array.from({ length: 2048 }, (_, i) => (2 * i) / 2048 - 1);
const waveState = () => ({ ...tool.createState(), ops: [bank.makeOp(30, "insert", "saw.wav", saw, 40)] });

// the key the session writes under is the one the store is asked for
ok("the record key is a single, stable key", RECORD_KEY === "workbench" && STORE_NAME === "session");

// ---- a session that loads an image and queues a change ---------------------------------

const store = createMemoryStore("fake");
{
  const s = createSession({ store, delay: 0 });
  const r = await s.setImage("Syntakt_OS1.41.syx", stockBytes);
  ok("the official file is accepted and becomes the image", r.ok && r.isStock && s.image.name === "Syntakt_OS1.41.syx");
  ok("the image is parsed once and handed to tools through the context",
    s.contextFor().baseParsed.version === "1.41" && s.contextFor().present.length === 0);
  ok("the official file loaded alone is also its own factory reference",
    s.contextFor().stockParsed === s.contextFor().baseParsed);

  const bad = await s.setImage("repack.syx", rd(EXP));
  ok("a refused file leaves the image that was already loaded in place",
    !bad.ok && s.image.name === "Syntakt_OS1.41.syx");

  s.setToolState("sychord-waves", waveState());
  ok("the tool state is held under its id", s.toolIds().join() === "sychord-waves");
  await s.flush();
  const saved = await store.get(RECORD_KEY);
  ok("autosave wrote one plain record: image bytes, no stock, one tool state",
    saved && saved.v === 1 && saved.image.bytes instanceof Uint8Array && saved.stock === null &&
    Object.keys(saved.tools).join() === "sychord-waves");
  ok("nothing parsed or DOM-shaped was persisted",
    !("parsed" in saved.image) && saved.image.bytes.length === stockBytes.length);
}

// ---- restore: a new session over the same store ------------------------------------------

{
  const s2 = createSession({ store, delay: 0 });
  const r = await s2.restore();
  ok("restore finds the record and re-verifies the image", r.hadRecord && r.image && r.image.ok && !r.droppedImage);
  ok("  ... the image is parsed again from its bytes, never trusted from storage",
    s2.image.parsed && s2.image.parsed.version === "1.41" && same(s2.image.bytes, stockBytes));
  const st = s2.getToolState("sychord-waves");
  ok("the tool state came back with its typed arrays intact",
    st.ops.length === 1 && st.ops[0].samples instanceof Float64Array && st.ops[0].samples.length === 2048 &&
    st.ops[0].samples[3] === saw[3] && st.ops[0].harmonics === 40);

  const ctx = s2.contextFor();
  const before = tool.contribute(waveState(), ctx)[0].bytes;
  const after = tool.contribute(st, ctx)[0].bytes;
  ok("serialise -> deserialise -> byte-identical contribution", same(before, after));
  ok("the restore message names what came back, in plain words",
    restoreMessage(r, 1) === "Welcome back. Loaded from last time: your file and 1 change.", restoreMessage(r, 1));
  ok("  ... and uses the plural for several changes", restoreMessage(r, 3).includes("3 changes"));
}

// ---- a corrupted stored image is dropped; the queue survives --------------------------------

{
  const record = await store.get(RECORD_KEY);
  record.image = { name: "broken.syx", bytes: rd(EXP) }; // parses, but does not verify
  await store.set(RECORD_KEY, record);

  const s3 = createSession({ store, delay: 0 });
  const r = await s3.restore();
  ok("an image that no longer verifies is dropped", r.droppedImage && s3.image === null);
  ok("  ... with a message that says what to do", r.messages.length === 1 && /queued changes are still here/.test(r.messages[0]),
    r.messages[0]);
  ok("  ... and the queued changes are kept", s3.getToolState("sychord-waves").ops.length === 1);
  ok("the restore message mentions the changes but not the file", restoreMessage(r, 1).startsWith("Welcome back. Loaded from last time: 1 change."));

  // loading a good image again puts the session back together
  const back = await s3.setImage("mine.syx", sawBytes);
  ok("loading another image over the same queue works", back.ok && !back.isStock && s3.image.mods[0].id === "sychord-waves");
  ok("  ... and the tool state, which is relative, is untouched", s3.getToolState("sychord-waves").ops[0].frame === 30);
  await s3.flush();
}

// ---- rubbish in the store is survivable -------------------------------------------------------

{
  const s = createSession({ store: createMemoryStore("fake"), delay: 0 });
  await s.setImage("x.syx", stockBytes);
  const older = createMemoryStore("fake");
  await older.set(RECORD_KEY, { v: 0, image: null, stock: null, tools: {} });
  const s4 = createSession({ store: older, delay: 0 });
  const r = await s4.restore();
  ok("a record from an older version of the site is discarded, not misread",
    r.hadRecord && !r.image && /older version/.test(r.messages[0]));
  ok("  ... and the store is cleaned up", (await older.get(RECORD_KEY)) === undefined);

  const hostile = createMemoryStore("fake");
  await hostile.set(RECORD_KEY, { v: 1, image: { name: "x", bytes: "not bytes" }, tools: { ghost: { a: 1 } } });
  const s5 = createSession({ store: hostile, delay: 0 });
  const r5 = await s5.restore();
  ok("a record whose bytes are not bytes is ignored rather than crashing", s5.image === null && !r5.droppedImage);
  ok("  ... while an unknown tool id is kept and simply never used", s5.toolIds().join() === "ghost");
}

// ---- the optional official file ------------------------------------------------------------------

{
  const st = createMemoryStore("fake");
  const s = createSession({ store: st, delay: 0 });
  await s.setImage("mine.syx", sawBytes);
  const bad = await s.setStock("mine.syx", sawBytes);
  ok("only the official file is accepted as the official file", !bad.ok && s.stock === null);
  const good = await s.setStock("Syntakt_OS1.41.syx", stockBytes);
  ok("the official file is accepted and reaches the tools", good.ok && s.contextFor().stockParsed.version === "1.41");
  await s.flush();
  const s6 = createSession({ store: st, delay: 0 });
  await s6.restore();
  ok("it comes back after a reload, re-verified", s6.stock && s6.stock.isStock && s6.contextFor().stockParsed !== null);
  s6.removeStock();
  await s6.flush();
  ok("removing it is persisted too", (await st.get(RECORD_KEY)).stock === null);
}

// ---- Forget wipes everything -------------------------------------------------------------------------

{
  const s = createSession({ store, delay: 0 });
  await s.restore();
  ok("there is something to forget", s.image !== null && s.toolIds().length === 1);
  await s.forget();
  ok("forget clears the session in memory", s.image === null && s.stock === null && s.toolIds().length === 0);
  ok("  ... and the store", (await store.get(RECORD_KEY)) === undefined);
  const s7 = createSession({ store, delay: 0 });
  const r = await s7.restore();
  ok("  ... so the next visit starts empty", !r.hadRecord && s7.image === null && restoreMessage(r, 0) === "");
}

// ---- debounce, and a store that refuses to work ----------------------------------------------------

{
  const slow = createMemoryStore("fake");
  const s = createSession({ store: slow, delay: 50 });
  await s.setImage("x.syx", stockBytes);
  ok("the write is debounced, not immediate", (await slow.get(RECORD_KEY)) === undefined);
  await s.flush();
  ok("flush forces it out", (await slow.get(RECORD_KEY)) !== undefined);

  const broken = { available: true, get: async () => { throw new Error("blocked"); },
    set: async () => { throw new Error("blocked"); }, remove: async () => {}, clear: async () => {} };
  const s8 = createSession({ store: broken, delay: 0 });
  const r = await s8.restore();
  ok("a store that cannot be read gives a message instead of an exception", r.hadRecord === false && r.messages.length === 1);
  const loaded = await s8.setImage("x.syx", stockBytes);
  await s8.flush();
  ok("a store that cannot be written does not stop the session", loaded.ok && s8.image !== null);
  ok("  ... and the page can say storage is not working", s8.storeAvailable === false);

  const none = createSession({ store: createMemoryStore(), delay: 0 });
  ok("the in-memory fallback reports itself as unavailable storage", none.storeAvailable === false);
}

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
