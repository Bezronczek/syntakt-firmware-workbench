// The workbench: one page, one image, one queue, one Build.
//
// This file is DOM only. Everything it decides with comes from modules the Node tests drive:
//   session.js       the loaded image, the tool states and the autosave
//   firmware-input.js what a dropped file is and what to say about it
//   workbench.js     validating an image without the official file, and building from contributions
//   tools.js         the registry; a tool is a plug-in and the workbench knows nothing about waves
//   router.js        #/ and #/<tool id>
//
// The workbench never writes firmware bytes itself: a tool hands it a rewritten copy of a section
// and workbench.buildImage takes only the bytes inside that mod's declared regions.
//
// A build that rewrites a compressed section has to pack it again, which takes about twenty
// seconds. It runs in js/build-worker.js when the browser has module workers, and on this thread
// when it does not; either way it is the same buildImage.

import * as fw from "./syntakt-fw.js";
import * as wb from "./workbench.js";
import * as fwin from "./firmware-input.js";
import { MODS, getMod } from "./mods.js";
import { createSession, restoreMessage } from "./session.js";
import { openStore } from "./store.js";
import { loadTools, TOOL_IDS } from "./tools.js";
import { createRouter } from "./router.js";
import { node, say, wireDrop, guardStrayDrops, focusHeading } from "./site.js";

const $ = (id) => document.getElementById(id);
const el = {
  workbench: $("view-workbench"), toolView: $("view-tool"),
  imageHead: $("image-head"), buildHead: $("build-head"),
  restore: $("restore-line"),
  drop: $("image-drop"), pick: $("image-pick"), input: $("image-input"),
  imageStatus: $("image-status"), imageCard: $("image-card"), imageProblem: $("image-problem"),
  storageLine: $("storage-line"),
  advice: $("stock-advice"), adviceText: $("stock-advice-text"), stockDrop: $("stock-drop"), stockPick: $("stock-pick"),
  stockInput: $("stock-input"), stockStatus: $("stock-status"), stockCard: $("stock-card"),
  toolList: $("tool-list"), queue: $("queue"),
  build: $("build"), buildNote: $("build-note"), checklist: $("checklist"),
  checkDetails: $("check-details"), checkSummary: $("check-summary"),
  buildStatus: $("build-status"), buildProgress: $("build-progress"), downloadRow: $("download-row"), download: $("download"),
  after: $("after"), contains: $("contains"),
  toolTitle: $("tool-title"), toolImage: $("tool-image"), toolBody: $("tool-body"),
  toolDone: $("tool-done"), toolBack: $("tool-back"),
};

const list = (a) => a.join(", ");
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

let tools = new Map();
let session = null;
let router = null;
let mounted = null;      // { id, tool }
let objectUrl = null;
let firstRoute = true;

// ---- what a tool has queued -------------------------------------------------------------

function ctx() {
  return session.contextFor();
}

function linesFor(id) {
  const tool = tools.get(id);
  const state = session.getToolState(id);
  if (!tool || !state || !session.image) return [];
  try {
    return tool.summarise(state, ctx()) || [];
  } catch {
    return [];
  }
}

const queuedIds = () => [...tools.keys()].filter((id) => linesFor(id).length > 0);
const presentIds = () => (session.image ? session.image.mods.map((m) => m.id) : []);
const totalQueued = () => queuedIds().reduce((n, id) => n + linesFor(id).length, 0);

/** Mods already in the image, or queued, that this tool cannot be combined with. */
function blockers(id) {
  const others = [...new Set([...presentIds(), ...queuedIds()])].filter((x) => x !== id);
  if (!others.length) return [];
  return wb.conflictsAmong([id, ...others])
    .filter((c) => c.a === id || c.b === id)
    .map((c) => (c.a === id ? c.b : c.a));
}

// ---- step 1: the image ---------------------------------------------------------------------

function fileRow(image, kind) {
  const box = node("div", "fw-file");
  const head = node("p", "fw-headline");
  head.append(node("strong", null, image.headline));
  box.append(head);
  box.append(node("p", "fw-meta", image.name + " - " + fwin.describeSize(image.size)));

  const buttons = node("p", "buttons");
  if (kind === "image") {
    const replace = node("button", "btn btn-small", "Replace file");
    replace.type = "button";
    replace.addEventListener("click", () => el.input.click());
    const forget = node("button", "btn btn-small", "Forget my files");
    forget.type = "button";
    forget.addEventListener("click", askForget);
    buttons.append(replace, forget);
  } else {
    const remove = node("button", "btn btn-small", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      session.removeStock();
      say(el.stockStatus, "Official file removed. Tools can no longer put the original sounds back.");
    });
    buttons.append(remove);
  }
  box.append(buttons);

  const d = document.createElement("details");
  d.append(node("summary", null, "Details"));
  const ul = node("ul");
  ul.append(node("li", null, "size: " + fwin.describeSizeExact(image.size)));
  ul.append(node("li", null, "SHA-256 starts with " + image.short));
  for (const line of image.modDetails || []) ul.append(node("li", null, "changed: " + line));
  d.append(ul);
  box.append(d);
  return box;
}

function showProblem(target, result) {
  target.replaceChildren();
  if (!result || result.ok) return;
  const box = node("div", "fw-problem");
  const head = result.headline || "That file was not used";
  box.append(node("strong", null, result.name && !head.includes(result.name) ? result.name + ": " + head : head));
  box.append(node("p", null, result.reason || ""));
  const details = result.details || [];
  if (details.length) {
    const d = document.createElement("details");
    d.append(node("summary", null, "Details"));
    const ul = node("ul");
    for (const line of details.slice(0, 40)) ul.append(node("li", null, line));
    if (details.length > 40) ul.append(node("li", null, "... and " + (details.length - 40) + " more"));
    d.append(ul);
    box.append(d);
  }
  target.append(box);
}

/** One or two files at once: the site sorts them out by what they verify as. */
async function ingestFiles(files) {
  if (!session) { say(el.imageStatus, "The page is still starting. Try again in a moment.", "bad"); return; }
  say(el.imageStatus, "Reading " + files.map((f) => f.name).join(", ") + " ...");
  el.imageProblem.replaceChildren();
  const records = [];
  for (const f of files) {
    try {
      records.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    } catch (err) {
      say(el.imageStatus, "That file could not be read. Try choosing it again.", "bad");
      return;
    }
  }
  const had = session.image;
  const r = await session.addFiles(records);
  for (const bad of r.refused) showProblem(el.imageProblem, bad);

  const said = [];
  if (r.image) said.push(r.image.headline + " loaded.");
  if (r.stock && r.stock !== r.image) said.push("Official file added.");
  said.push(...r.notes);
  if (r.image || r.stock) {
    say(el.imageStatus, said.join(" ") + " Next: open a tool below.", "ok");
    invalidateBuild();
  } else {
    say(el.imageStatus, had ? "Nothing was loaded. You are still working on " + had.name + "." : "Nothing was loaded yet.", "bad");
  }
  render();
}

async function ingestStock(file) {
  say(el.stockStatus, "Reading " + file.name + " ...");
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    say(el.stockStatus, "That file could not be read. Try choosing it again.", "bad");
    return;
  }
  const r = await session.setStock(file.name, bytes);
  if (!r.ok) {
    showProblem(el.stockCard, r);
    el.stockCard.hidden = false;
    say(el.stockStatus, "That is not the official file, so nothing changed.", "bad");
    return;
  }
  say(el.stockStatus, "Official file added. Tools can now put the original sounds back.", "ok");
  render();
}

function askForget() {
  const box = node("div", "ask");
  box.append(node("p", null,
    "Erase your file and all your changes from this browser? Files on your disk are not touched. " +
    "This cannot be undone."));
  const buttons = node("div", "buttons");
  const yes = node("button", "btn btn-primary btn-small", "Erase");
  yes.type = "button";
  yes.addEventListener("click", async () => {
    await session.forget();
    el.restore.hidden = true;
    el.imageProblem.replaceChildren();
    el.stockCard.replaceChildren();
    el.stockCard.hidden = true;
    say(el.stockStatus, "");
    invalidateBuild();
    say(el.imageStatus, "Everything erased. Drop your firmware file to start again.");
    router.go(null);
    render();
  });
  const no = node("button", "btn btn-small", "Keep them");
  no.type = "button";
  no.addEventListener("click", () => render());
  buttons.append(yes, no);
  box.append(buttons);
  el.imageProblem.replaceChildren(box);
  yes.focus();
}

// ---- step 2: the tool cards --------------------------------------------------------------------

function cardState(id) {
  if (!session.image) return { kind: "locked", text: "Load a firmware file first." };
  const blocked = blockers(id);
  if (blocked.length) {
    return { kind: "blocked", text: "Cannot be used together with " + list(blocked.map((b) => getMod(b).title)) +
      ". Clear that one first." };
  }
  const n = linesFor(id).length;
  if (n) return { kind: "queued", text: plural(n, "change", "changes") + " ready to build." };
  const here = (session.image.mods || []).find((m) => m.id === id);
  if (here) return { kind: "present", text: "Already in your file. Open it to change more." };
  return { kind: "idle", text: "No changes yet." };
}

function renderTools() {
  const frag = document.createDocumentFragment();
  for (const m of MODS) {
    if (m.status && m.status !== "available") continue;
    const st = cardState(m.id);
    const li = node("li", "mod-card is-" + st.kind);
    const tags = node("p", "tags");
    tags.append(node("span", "tag is-available", "Available now"));
    if (m.about && m.about.badge) tags.append(node("span", "tag is-proven", m.about.badge));
    li.append(tags);
    li.append(node("h3", null, m.title));
    li.append(node("p", null, m.summary));
    if (m.touches) li.append(node("p", "touches", m.touches));
    if (m.about) {
      const dl = node("dl", "facts");
      for (const [k, v] of m.about.facts || []) dl.append(node("dt", null, k), node("dd", null, v));
      li.append(dl);
      if ((m.about.more || []).length) {
        const d = document.createElement("details");
        d.className = "about-more";
        d.append(node("summary", null, "More about this tool"));
        for (const [h, text] of m.about.more) d.append(node("h4", null, h), node("p", null, text));
        li.append(d);
      }
    }
    li.append(node("p", "card-state", st.text));
    const go = node("p", "go");
    const open = node("button", "btn", st.kind === "queued" ? "Open again" : "Open");
    open.type = "button";
    open.disabled = st.kind === "locked" || st.kind === "blocked";
    open.addEventListener("click", () => router.go(m.id));
    go.append(open);
    if (st.kind === "queued") {
      const clear = node("button", "btn btn-small", "Clear");
      clear.type = "button";
      clear.addEventListener("click", () => {
        session.clearTool(m.id);
        invalidateBuild();
      });
      go.append(clear);
    }
    li.append(go);
    frag.append(li);
  }
  if (!frag.childNodes.length) frag.append(node("li", "empty", "No tools are published yet."));
  el.toolList.replaceChildren(frag);
}

// ---- step 3: the queue -----------------------------------------------------------------------------

function renderQueue() {
  const frag = document.createDocumentFragment();
  const ids = queuedIds();
  for (const id of ids) {
    const group = node("div", "queue-group");
    const head = node("div", "queue-head");
    head.append(node("h4", null, getMod(id).title));
    const buttons = node("span", "buttons");
    const edit = node("button", "btn btn-small", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => router.go(id));
    const clear = node("button", "btn btn-small", "Clear");
    clear.type = "button";
    clear.setAttribute("aria-label", "Clear all changes of " + getMod(id).title);
    clear.addEventListener("click", () => {
      session.clearTool(id);
      invalidateBuild();
    });
    buttons.append(edit, clear);
    head.append(buttons);
    group.append(head);
    const ul = node("ul", "queue-lines");
    for (const line of linesFor(id)) ul.append(node("li", null, line));
    group.append(ul);
    frag.append(group);
  }
  if (!ids.length) {
    frag.append(node("div", "empty", session.image
      ? "No changes yet. Open a tool in step 2."
      : "No changes yet."));
  }
  el.queue.replaceChildren(frag);

  const ready = !!session.image && ids.length > 0;
  el.build.disabled = !ready;
  el.buildNote.textContent = !session.image
    ? "Load a firmware file first."
    : ids.length
      ? plural(totalQueued(), "change", "changes") + " will be written. Everything else stays as it is."
      : "Make a change in a tool first.";
}

function invalidateBuild() {
  el.checklist.replaceChildren();
  say(el.buildStatus, "");
  el.checkDetails.hidden = true;
  el.checkDetails.open = false;
  el.downloadRow.hidden = true;
  el.after.hidden = true;
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
}

function renderChecklist(rows) {
  el.checkDetails.hidden = false; // shown only once there is something to read in it
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const li = node("li", r.ok === null ? "" : r.ok ? "ok" : "bad");
    li.append(node("span", "mark", r.ok === null ? "•" : r.ok ? "✓" : "✗"));
    li.append(node("span", "visually-hidden", r.ok === null ? "" : r.ok ? "passed: " : "failed: "));
    const body = node("span");
    body.append(document.createTextNode(r.name));
    if (r.detail) body.append(node("span", "detail", r.detail));
    li.append(body);
    frag.append(li);
  }
  el.checklist.replaceChildren(frag);
}

/** A worker that could not even start: fall back to this thread rather than fail the build. */
const broken = (err) => Object.assign(err, { workerBroken: true });

function buildInWorker(baseParsed, contributions, level, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./build-worker.js", import.meta.url), { type: "module" });
    } catch (err) {
      reject(broken(err instanceof Error ? err : new Error(String(err))));
      return;
    }
    const finish = (fn, arg) => { worker.terminate(); fn(arg); };
    worker.onerror = () => finish(reject, broken(new Error("the background build could not start")));
    worker.onmessageerror = () => finish(reject, broken(new Error("the background build sent something unreadable")));
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.progress) { if (onProgress) onProgress(m.progress); return; }
      if (m.ok) finish(resolve, { file: m.file, report: m.report });
      else finish(reject, new Error(m.error || "the build failed"));
    };
    worker.postMessage({ fileBytes: baseParsed.file, contributions, level });
  });
}

/** buildImage, in a worker when there is one. -> { file, report } */
async function runBuild(baseParsed, contributions, level, onProgress) {
  if (typeof Worker === "function") {
    try {
      return await buildInWorker(baseParsed, contributions, level, onProgress);
    } catch (err) {
      if (!err.workerBroken) throw err;
    }
  }
  // On this thread the page cannot repaint while packing, so the bar stays where it is.
  return wb.buildImage(baseParsed, contributions, undefined, undefined, { level, onProgress });
}

async function doBuild() {
  el.build.disabled = true;
  invalidateBuild();
  say(el.buildStatus, "Building your image ...");
  const rows = [];
  const add = (name, ok, detail) => { rows.push({ name, ok, detail: detail || "" }); return ok; };
  const c = ctx();

  try {
    const before = await wb.verifyImage(c.baseParsed);
    add("The file you loaded is still the one that was checked", before.ok,
      before.isStock ? "official Syntakt OS 1.41" : "mods present: " + (before.mods.map((m) => m.title).join(", ") || "none"));

    const ids = queuedIds();
    const all = [...new Set([...before.mods.map((m) => m.id), ...ids])];
    const clash = wb.conflictsAmong(all);
    add("No two tools write over each other", clash.length === 0,
      clash.length ? clash.map((x) => x.a + " + " + x.b).join(", ") : list(all));

    const contributions = [];
    const notes = [];
    let frames = [];
    for (const id of ids) {
      const tool = tools.get(id);
      const state = session.getToolState(id);
      for (const part of tool.contribute(state, c)) {
        contributions.push({ modId: id, section: part.section, bytes: part.bytes });
        if (part.note) notes.push(part.note);
      }
      if (tool.changedFrames) frames = frames.concat(tool.changedFrames(state, c));
    }

    // Packing a compressed section again is the slow part, and the only one worth warning about.
    const slow = contributions.some((x) => fw.isCompressed(c.baseParsed, x.section));
    say(el.buildStatus, slow ? "Building your image. This takes about 20 seconds." : "Building your image ...");
    el.buildProgress.value = 0;
    el.buildProgress.hidden = !slow;
    const onProgress = (p) => {
      if (p.phase !== "pack") return;
      const pct = Math.min(100, Math.floor(p.fraction * 100));
      el.buildProgress.value = pct;
      say(el.buildStatus, "Packing the firmware program: " + pct + "%");
    };
    const res = await runBuild(c.baseParsed, contributions, 3, onProgress);
    el.buildProgress.hidden = true;
    add("Every tool stayed inside the bytes it declared", res.report.strayWrites.length === 0,
      res.report.strayWrites.length
        ? res.report.strayWrites.map((s) => s.modId + " wrote " + plural(s.count, "byte", "bytes") +
          " outside its regions in section " + s.section + " (they were discarded)").join("; ")
        : "checked " + plural(contributions.length, "contribution", "contributions"));

    let reparsed = null;
    try {
      reparsed = fw.parseSyx(res.file);
      add("The new file reads back correctly, with valid checksums", true,
        "OS " + reparsed.version + ", " + reparsed.sections.length + " sections");
    } catch (err) {
      add("The new file reads back correctly, with valid checksums", false, String(err.message || err));
    }
    add("Image size: " + res.file.length + " bytes; it was " + c.baseParsed.file.length, null,
      res.file.length === c.baseParsed.file.length ? "unchanged" : "a part of it was packed again");

    const after = reparsed ? await wb.verifyImage(reparsed) : { ok: false, mods: [], unknown: [{ reason: "the output did not parse" }] };
    add("Nothing changed outside what the tools are allowed to touch", after.ok,
      after.ok ? "checked every section against the official OS 1.41 fingerprints"
        : fwin.describeUnknown(after.unknown).join("; "));
    add("What the new file contains", after.mods.length > 0,
      after.mods.map(fwin.describeModDetail).join("; ") || "none");

    if (frames.length) add("Waves written", null, list([...new Set(frames)].sort((a, b) => a - b).map((k) => "WAVE " + 4 * k)));
    for (const note of notes) add(note, null);
    const sha = await fw.sha256hex(res.file);
    add("SHA-256 of the new file", null, sha);
    renderChecklist(rows);

    const allOk = rows.every((r) => r.ok !== false);
    el.checkSummary.textContent = allOk
      ? "Details: " + plural(rows.filter((r) => r.ok === true).length, "check", "checks") + " passed"
      : "Details: what failed";
    el.checkDetails.open = !allOk;
    if (allOk) {
      objectUrl = URL.createObjectURL(new Blob([res.file], { type: "application/octet-stream" }));
      el.download.href = objectUrl;
      el.download.download = "Syntakt_OS1.41_custom.syx";
      el.downloadRow.hidden = false;
      el.after.hidden = false;
      el.contains.textContent = after.mods.length
        ? "Your changes from: " + list(after.mods.map((m) => m.title)) + ". Everything else is the official OS 1.41."
        : "Nothing at all: this file is the official OS 1.41.";
      say(el.buildStatus, "Your file is ready. Download it below, then read how to flash it.", "ok");
    } else {
      say(el.buildStatus, "A check failed, so there is no download. Nothing was sent to your instrument and " +
        "your own file is untouched. See the details below.", "bad");
    }
  } catch (err) {
    add("Build", false, String(err.message || err));
    renderChecklist(rows);
    el.checkSummary.textContent = "Details: what failed";
    el.checkDetails.open = true;
    say(el.buildStatus, "The build stopped, so there is no download. Your own file is untouched.", "bad");
  } finally {
    el.build.disabled = !(session.image && queuedIds().length);
    primaryButton();
  }
}

// ---- rendering the workbench --------------------------------------------------------------------------

function render() {
  const image = session.image;
  el.imageCard.hidden = !image;
  el.imageCard.replaceChildren();
  if (image) {
    el.imageCard.append(fileRow(image, "image"));
  }
  const lead = document.getElementById("step1-lead");
  if (lead) lead.textContent = image ? "Firmware loaded. Next: open a tool in step 2." : "Drop your Syntakt firmware file here.";
  el.drop.hidden = !!image; // the file card has its own Replace file button
  const advice = fwin.stockAdvice(image, session.stock);
  el.advice.hidden = !advice.show;
  el.advice.className = "advice" + (advice.have ? " is-have" : "");
  el.adviceText.textContent = advice.text;
  el.stockDrop.hidden = advice.have;
  el.stockCard.hidden = !session.stock;
  if (session.stock) el.stockCard.replaceChildren(fileRow(session.stock, "stock"));

  renderTools();
  renderQueue();
  primaryButton();
  if (mounted) el.toolImage.textContent = fwin.describeImage(session.image);
}

/**
 * Exactly one red button at a time: the thing to do next. Choose file -> Open a tool ->
 * Build -> Download.
 */
function primaryButton() {
  const queued = !!session.image && queuedIds().length > 0;
  const downloadable = !el.downloadRow.hidden;
  el.pick.className = "btn" + (session.image ? "" : " btn-primary");
  el.build.className = "btn" + (queued && !downloadable ? " btn-primary" : "");
  for (const b of el.toolList.querySelectorAll("button")) {
    if (b.textContent === "Open") b.className = "btn" + (session.image && !queued ? " btn-primary" : "");
  }
}

// ---- routing ------------------------------------------------------------------------------------------

function unmountTool() {
  if (!mounted) return;
  try { mounted.tool.unmount(); } catch { /* a view that failed to mount has nothing to drop */ }
  el.toolBody.replaceChildren();
  mounted = null;
}

function showWorkbench(focus) {
  unmountTool();
  el.toolView.hidden = true;
  el.workbench.hidden = false;
  if (focus) focusHeading(el.imageHead);
}

function openTool(id) {
  const tool = tools.get(id);
  if (!tool) { router.go(null); return; }
  if (!session.image) {
    showWorkbench(true);
    say(el.imageStatus, "Load your firmware file first, then open the tool.", "bad");
    return;
  }
  const blocked = blockers(id);
  if (blocked.length) {
    showWorkbench(true);
    say(el.imageStatus, getMod(id).title + " cannot be used together with " +
      list(blocked.map((b) => getMod(b).title)) + ". Clear that one first.", "bad");
    return;
  }
  unmountTool();
  el.workbench.hidden = true;
  el.toolView.hidden = false;
  el.toolTitle.textContent = getMod(id).title;
  el.toolImage.textContent = fwin.describeImage(session.image);
  let state = session.getToolState(id);
  if (!state) { state = tool.createState(); session.setToolState(id, state); }
  mounted = { id, tool };
  try {
    tool.mount(el.toolBody, state, ctx(), (next) => {
      session.setToolState(id, next);
      invalidateBuild();
    });
  } catch (err) {
    el.toolBody.replaceChildren(node("p", "status bad",
      "This tool could not open. Reload the page and try again. (" + (err.message || err) + ")"));
  }
  focusHeading(el.toolTitle);
}

function onRoute(route) {
  const focus = !firstRoute;
  firstRoute = false;
  if (route.view === "tool") openTool(route.toolId);
  else showWorkbench(focus);
}

// ---- boot ----------------------------------------------------------------------------------------------

guardStrayDrops();

el.pick.addEventListener("click", () => el.input.click());
el.input.addEventListener("change", () => {
  const files = [...(el.input.files || [])];
  el.input.value = "";
  if (files.length) ingestFiles(files);
});
wireDrop(el.drop, (files) => ingestFiles(files));

el.stockPick.addEventListener("click", () => el.stockInput.click());
el.stockInput.addEventListener("change", () => {
  const files = [...(el.stockInput.files || [])];
  el.stockInput.value = "";
  if (files.length) ingestStock(files[0]);
});
wireDrop(el.stockDrop, (files) => ingestStock(files[0]));

el.build.addEventListener("click", doBuild);
el.toolDone.addEventListener("click", () => {
  router.go(null);
  focusHeading(el.buildHead);
});
el.toolBack.addEventListener("click", (e) => { e.preventDefault(); router.go(null); });

(async function boot() {
  try {
    tools = await loadTools();
  } catch (err) {
    say(el.imageStatus, "The tools could not be loaded. Reload the page. (" + (err.message || err) + ")", "bad");
    return;
  }
  const store = await openStore();
  session = createSession({ store });
  session.onChange(render);
  router = createRouter(TOOL_IDS, onRoute);

  let restored = null;
  try {
    restored = await session.restore();
  } catch (err) {
    restored = { hadRecord: false, messages: ["Your last session could not be read, so this is a fresh start."] };
  }
  render();

  const msg = restoreMessage(restored, totalQueued());
  if (msg) {
    el.restore.hidden = false;
    el.restore.replaceChildren(node("span", null, msg));
    const forget = node("button", "btn btn-small", "Forget my files");
    forget.type = "button";
    forget.addEventListener("click", askForget);
    el.restore.append(forget);
  }
  if (!session.storeAvailable) {
    el.storageLine.textContent = "This browser will not let the site remember anything, so a reload loses your " +
      "work. Everything still happens in this tab only.";
  }
  router.start();
})();
