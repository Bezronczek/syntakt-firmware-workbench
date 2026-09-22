// The SY CHORD wave bank tool, as a workbench plug-in (see js/tools.js for the interface).
//
// The tool owns nothing but its own state:
//
//   { ops, defaultHarmonics, allowFrame0, revertToFactory, drawPictures }
//   ops[i] = { frame, mode: "replace"|"insert", name, samples: Float64Array, harmonics }
//
// which is plain structured-clone-able data, so the workbench can autosave it and hand it back
// after a reload unchanged. Every byte-level decision still lives in ../bank.js (the operations
// list, the raw frame copies, building section 7), ../wave-dsp.js (WAV decoding and cycle
// conditioning) and ../wave-picture.js (the pictures the screen draws), which is what the Node
// tests drive.
//
// The tool never builds an image and never offers a download: contribute() hands the workbench
// its rewritten copy of section 7, and - when the pictures are switched on - of the decompressed
// section 3, and the workbench takes only the bytes inside the mod's declared regions.

import * as fw from "../syntakt-fw.js";
import * as bank from "../bank.js";
import { node, say, wireDrop, saveBlob } from "../site.js";
import { decodeWav, encodeWavFloat32, DEFAULT_HARMONICS, MIN_HARMONICS, MAX_HARMONICS } from "../wave-dsp.js";
import { picturesForBank } from "../wave-picture.js";
import { BLOCK_OF_VALUE, OPERANDS, SECTION_BASE } from "../sychord-picture-map.js";

const MOD_ID = "sychord-waves";
const SECTION = fw.WAVE.SECTION_ID;
const PICTURE_SECTION = 3;      // MAIN OS, stored compressed: these offsets are into its raw bytes
const PICTURE_LINE = "Wave pictures on the screen updated to match.";

const pct = (x) => (x > 0 && x < 0.01 ? "<0.01%" : x.toFixed(2) + "%");
const list = (a) => a.join(", ");

// ---- state, DOM free -------------------------------------------------------------------

export function createState() {
  return { ops: [], defaultHarmonics: DEFAULT_HARMONICS, allowFrame0: false, revertToFactory: false, drawPictures: true };
}

/** Pictures are on unless the user switched them off, including for a state saved before they existed. */
const drawsPictures = (state) => !state || state.drawPictures !== false;

/** The operations that actually count: frame 0 only when it is unlocked. */
function opsOf(state) {
  const ops = Array.isArray(state && state.ops) ? state.ops : [];
  return state && state.allowFrame0 ? ops : ops.filter((o) => o.frame !== 0);
}

const canRevert = (state, ctx) => !!(state && state.revertToFactory && ctx && ctx.stockParsed);

/** Section 7 the operations are replayed over: the loaded image, factory waves if reverting. */
function baseSection(state, ctx) {
  const section = fw.getSection(ctx.baseParsed, SECTION);
  if (!canRevert(state, ctx)) return section;
  return bank.revertWaveRegions(section, fw.getSection(ctx.stockParsed, SECTION));
}

function describeOp(op) {
  const wave = "WAVE " + bank.waveValue(op.frame);
  return op.mode === "insert"
    ? "Insert " + op.name + " at " + wave + ". The waves above it move up one step."
    : "Replace " + wave + " with " + op.name + ".";
}

/** What the user actually asked for. The picture line is a consequence, not a change of its own. */
function changeLines(state, ctx) {
  const lines = [];
  if (canRevert(state, ctx)) lines.push("Put all waves back to the original ones.");
  for (const op of opsOf(state)) lines.push(describeOp(op));
  return lines;
}

export function summarise(state, ctx) {
  const lines = changeLines(state, ctx);
  if (lines.length && drawsPictures(state)) lines.push(PICTURE_LINE);
  return lines;
}

/**
 * A copy of the decompressed MAIN OS section with the 128 wave pictures redrawn from the
 * waves this build writes. 125 values own a block; the three that do not get a pointer to
 * the block of the value next to them, so they show a picture of the right shape too.
 */
function pictureSection(ctx, sectionBytes) {
  const raw = fw.getSectionRaw(ctx.baseParsed, PICTURE_SECTION).slice();
  const frames = Array.from({ length: bank.FRAME_COUNT }, (_, k) => fw.readFrame(sectionBytes, k));
  const pictures = picturesForBank(frames);
  const shared = new Set(OPERANDS.map((o) => o.value));
  for (let v = 0; v < pictures.length; v++) if (!shared.has(v)) raw.set(pictures[v], BLOCK_OF_VALUE[v]);
  for (const o of OPERANDS) {
    const address = SECTION_BASE + BLOCK_OF_VALUE[o.showValue];
    raw[o.pointer] = (address >>> 24) & 0xff;
    raw[o.pointer + 1] = (address >>> 16) & 0xff;
    raw[o.pointer + 2] = (address >>> 8) & 0xff;
    raw[o.pointer + 3] = address & 0xff;
  }
  return raw;
}

export function contribute(state, ctx) {
  if (!changeLines(state, ctx).length) return [];
  const base = baseSection(state, ctx);
  const built = bank.buildSection(base, bank.replayOps(opsOf(state)), { allowFrame0: !!state.allowFrame0 });
  const parts = [{ section: SECTION, bytes: built.section }];
  if (drawsPictures(state)) {
    parts.push({
      section: PICTURE_SECTION,
      bytes: pictureSection(ctx, built.section),
      note: "Wave pictures on the screen: all 128 redrawn from your waves",
    });
  }
  return parts;
}

/** Frames this contribution rewrites; shown in the build checklist. */
export function changedFrames(state, ctx) {
  if (!changeLines(state, ctx).length) return [];
  return bank.buildSection(baseSection(state, ctx), bank.replayOps(opsOf(state)), { allowFrame0: !!state.allowFrame0 }).changed;
}

// ---- the view --------------------------------------------------------------------------

const VIEW = `
<p class="lead-line">Pick a wave, then drop a WAV file on it.</p>
<p class="hint small">
  The WAVE knob of SY CHORD sweeps through these 32 waves, left to right, and morphs between them.
  Nothing is written here: you build your file in step 3.
</p>
<div class="tool-note" data-x="note" hidden></div>
<div class="strip" data-x="strip" role="group" aria-label="The 32 waves, WAVE 0 to WAVE 124. Use the arrow keys to move between them."></div>
<div class="axis-row"><span>WAVE 0</span><span>32</span><span>64</span><span>96</span><span>124</span></div>
<div class="legend">
  <span><i style="background:var(--ink-dim)"></i>original</span>
  <span><i style="background:var(--accent)"></i>yours</span>
  <span><i style="background:var(--moved)"></i>moved up by an insert</span>
</div>

<details class="settings">
  <summary>Settings</summary>
  <div class="setgrid">
    <div>
      <label for="wt-defharm">Brightness of new waves: <b data-x="defharmOut">40</b> harmonics</label>
      <input type="range" id="wt-defharm" data-x="defharm" min="8" max="127" step="1" value="40">
      <small>
        40 is a safe default. Lower it if your waves sound harsh on high notes. You can change this
        for each wave after loading it.
      </small>
    </div>
    <div>
      <label><input type="checkbox" data-x="unlock0"> Allow changing WAVE 0</label>
      <small>
        WAVE 0 is a sine that other machines share. Changing it changes their sound too. Leave this
        off unless you know you want that.
      </small>
      <label><input type="checkbox" data-x="pics" checked> Draw my waves on the Syntakt screen too</label>
      <small>
        The little picture in the WAVE cell then shows your own shapes instead of the original ones.
        Switch it off and only the sound changes.
      </small>
      <div class="buttons">
        <button type="button" class="btn btn-small" data-x="resetAll">Undo all my changes</button>
        <button type="button" class="btn btn-small" data-x="exportWav">Export these waves as WAV</button>
      </div>
      <small>
        The export is one WAV file with all 32 waves, one after another, read from your own file.
      </small>
    </div>
  </div>
</details>

<div class="editor">
  <div class="big" data-x="big" aria-hidden="true"></div>
  <div class="side">
    <h3 data-x="title">WAVE 0</h3>
    <p class="state" data-x="state"></p>
    <div class="modes" data-x="modes">
      <label><input type="radio" name="wt-mode" value="replace" checked> Replace this wave</label>
      <label><input type="radio" name="wt-mode" value="insert"> Insert before it</label>
    </div>
    <p class="consequence" data-x="consequence"></p>
    <p>
      <button type="button" class="btn btn-primary" data-x="loadWav">Load a WAV file</button>
      <span class="dim small">or drop one on a wave above</span>
    </p>
    <div class="limiter" data-x="limiter" hidden>
      <label for="wt-harm">Brightness: <b data-x="harmOut"></b> harmonics</label>
      <input type="range" id="wt-harm" data-x="harm" min="8" max="127" step="1">
      <small data-x="harmNote"></small>
      <details><summary>Details</summary><small data-x="harmDetail"></small></details>
    </div>
    <div class="nav">
      <button type="button" class="btn btn-small" data-x="prev">&larr; previous wave</button>
      <button type="button" class="btn btn-small" data-x="next">next wave &rarr;</button>
    </div>
  </div>
</div>

<div class="changes">
  <h3>Your changes <span class="dim" data-x="chgCount"></span></h3>
  <p class="hint small">These are built into your file in step 3, in this order.</p>
  <div data-x="ask"></div>
  <div data-x="chgList"></div>
  <p class="status" data-x="status" role="status" aria-live="polite"></p>
</div>

<input type="file" data-x="wavInput" accept=".wav,.WAV,audio/wav" multiple class="visually-hidden">
`;

let view = null; // the mounted view, or null

export function mount(container, initial, ctx, onChange) {
  unmount();
  container.innerHTML = VIEW;
  const el = {};
  for (const n of container.querySelectorAll("[data-x]")) el[n.dataset.x] = n;

  const ui = { sel: 1, cells: [], objectUrls: [] };
  let state = { ...createState(), ...(initial || {}) };
  if (!Array.isArray(state.ops)) state.ops = [];

  const stockSection = ctx.stockParsed ? fw.getSection(ctx.stockParsed, SECTION) : null;
  const wavePresent = (ctx.present || []).some((m) => m.id === MOD_ID);
  let section = baseSection(state, ctx);
  let baseChanged = stockSection ? bank.changedFramesVsStock(stockSection, section) : [];

  const currentBank = () => bank.replayOps(opsOf(state));

  function commit(patch) {
    state = { ...state, ...patch };
    section = baseSection(state, ctx);
    baseChanged = stockSection ? bank.changedFramesVsStock(stockSection, section) : [];
    onChange(state);
    render();
  }

  // ---- notice for an image whose waves we cannot compare with the factory ones ----------

  if (!stockSection && wavePresent) {
    el.note.hidden = false;
    el.note.append(node("p", null,
      "Some waves in your file are already changed. To see which ones, and to put the original waves " +
      "back, add the official firmware file on the workbench (step 1 recommends it). You can make " +
      "changes and build without it."));
  }

  // ---- drawing --------------------------------------------------------------------------

  /** One cycle as an inline SVG path; crisp at any size, restyled by CSS for each state. */
  function waveSvg(cycle, points) {
    let peak = 0;
    for (const x of cycle) peak = Math.max(peak, Math.abs(x));
    const scale = peak > 0 ? 44 / peak : 0;
    const n = Math.min(points, cycle.length);
    const stepBy = cycle.length / n;
    let d = "";
    for (let i = 0; i <= n; i++) {
      const v = cycle[Math.round(i * stepBy) % cycle.length]; // closes on the guard sample
      d += (i ? "L" : "M") + ((i / n) * 100).toFixed(2) + " " + (50 - v * scale).toFixed(2) + " ";
    }
    return '<svg class="wave" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="axis" d="M0 50 L100 50"/><path class="trace" d="' + d.trim() + '"/></svg>';
  }

  /** "factory" | "moved" | "custom" | "image" -- what the cell and the editor show. */
  function slotState(b, k) {
    const e = b[k];
    if (e.kind === "custom") return "custom";
    if (e.from !== k) return "moved";
    return baseChanged.includes(k) ? "image" : "factory";
  }

  function slotLabel(b, k, st) {
    const e = b[k];
    const head = "WAVE " + bank.waveValue(k) + ", ";
    if (st === "custom") return head + "your wave " + e.name;
    if (st === "moved") return head + "original wave moved up from WAVE " + bank.waveValue(e.from);
    if (st === "image") return head + "already changed in your image";
    if (k === 0) return head + "the sine other machines share" + (state.allowFrame0 ? "" : ", locked");
    return head + "original wave";
  }

  // ---- the strip -------------------------------------------------------------------------

  const frag = document.createDocumentFragment();
  for (let k = 0; k < bank.FRAME_COUNT; k++) {
    const cell = node("button", "cell");
    cell.type = "button";
    cell.dataset.k = String(k);
    cell.addEventListener("click", () => select(k));
    wireDrop(cell, (files) => onWavDrop(k, files));
    frag.append(cell);
    ui.cells.push(cell);
  }
  el.strip.replaceChildren(frag);

  el.strip.addEventListener("keydown", (e) => {
    const map = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    let k = null;
    if (e.key in map) k = ui.sel + map[e.key];
    else if (e.key === "Home") k = 0;
    else if (e.key === "End") k = bank.FRAME_COUNT - 1;
    if (k === null) return;
    e.preventDefault();
    select(Math.max(0, Math.min(bank.FRAME_COUNT - 1, k)), true);
  });

  function select(k, focus) {
    ui.sel = k;
    render();
    if (focus && ui.cells[k]) ui.cells[k].focus();
  }

  // ---- importing waves ---------------------------------------------------------------------

  function modeNow() {
    const r = el.modes.querySelector('input[name="wt-mode"]:checked');
    return r ? r.value : "replace";
  }

  function onWavDrop(k, files) {
    const wavs = files.filter((f) => /\.wav$/i.test(f.name));
    if (!wavs.length) { say(el.status, "That was not a WAV file. Drop a single-cycle WAV instead.", "bad"); return; }
    if (wavs.length === 1) { select(k); importWav(k, wavs[0], modeNow()); return; }
    const sorted = wavs.slice().sort((a, b) => a.name.localeCompare(b.name));
    const first = Math.max(k, state.allowFrame0 ? 0 : 1);
    const used = Math.min(sorted.length, bank.FRAME_COUNT - first);
    askInline(
      "Put these " + used + " waves on WAVE " + bank.waveValue(first) + " to " + bank.waveValue(first + used - 1) +
      ", in name order?" + (sorted.length > used ? " " + (sorted.length - used) + " will not fit and are ignored." : ""),
      "Yes, add " + used + " waves",
      async () => {
        let done = 0, last = "";
        for (let i = 0; i < used; i++) {
          const okNow = await importWav(first + i, sorted[i], "replace", true);
          if (okNow) done++; else last = sorted[i].name;
        }
        select(first);
        say(el.status, done + " wave(s) added from WAVE " + bank.waveValue(first) + " up." +
          (done < used ? " " + (used - done) + " file(s) could not be read, the last one was " + last + "." : "") +
          " Add more, or press Done and build.",
          done < used ? "bad" : "");
      });
  }

  async function importWav(k, file, mode, quiet) {
    if (k === 0 && !state.allowFrame0) {
      say(el.status, "WAVE 0 is locked. Open Settings and allow it, if you really want to change the " +
        "sine that other machines share.", "bad");
      return false;
    }
    let op;
    try {
      const wav = decodeWav(await file.arrayBuffer());
      op = bank.makeOp(k, mode, file.name, wav.samples, clampHarm(state.defaultHarmonics));
      bank.opEntry(op); // conditions the wave now, so a bad file fails here and not at build time
      if (wav.channels > 1 && !quiet) say(el.status, file.name + ": stereo file, only the left channel was used.");
    } catch (err) {
      if (!quiet) say(el.status, file.name + " could not be used: " + (err.message || err) +
        " Try a single-cycle WAV file.", "bad");
      return false;
    }
    commit({ ops: bank.addOp(state.ops, op) });
    if (!quiet) {
      say(el.status, file.name + (op.mode === "insert" ? " inserted at WAVE " : " added to WAVE ") +
        bank.waveValue(k) + ". Add more waves, or press Done and build.");
    }
    return true;
  }

  el.loadWav.addEventListener("click", () => { el.wavInput.multiple = false; el.wavInput.click(); });
  el.wavInput.addEventListener("change", () => {
    const files = [...(el.wavInput.files || [])];
    el.wavInput.value = "";
    if (files.length) importWav(ui.sel, files[0], modeNow());
  });
  wireDrop(el.big, (files) => onWavDrop(ui.sel, files));

  // ---- inline questions (never window.confirm) -----------------------------------------------

  function askInline(question, yesLabel, onYes) {
    const box = node("div", "ask");
    box.append(node("p", null, question));
    const buttons = node("div", "buttons");
    const yes = node("button", "btn btn-primary btn-small", yesLabel);
    yes.type = "button";
    yes.addEventListener("click", () => { el.ask.replaceChildren(); onYes(); });
    const no = node("button", "btn btn-small", "Cancel");
    no.type = "button";
    no.addEventListener("click", () => { el.ask.replaceChildren(); });
    buttons.append(yes, no);
    box.append(buttons);
    el.ask.replaceChildren(box);
    yes.focus();
  }

  // ---- settings ------------------------------------------------------------------------------

  el.defharm.addEventListener("input", () => {
    const h = clampHarm(el.defharm.value);
    el.defharmOut.textContent = String(h);
    commit({ defaultHarmonics: h });
  });

  el.unlock0.addEventListener("change", () => {
    const on = el.unlock0.checked;
    const kept = on ? state.ops : state.ops.filter((o) => o.frame !== 0);
    if (!on && kept.length !== state.ops.length) {
      say(el.status, "WAVE 0 is locked again, so your change to it was removed.");
    }
    commit({ allowFrame0: on, ops: kept });
  });

  el.pics.addEventListener("change", () => {
    const on = el.pics.checked;
    commit({ drawPictures: on });
    say(el.status, on
      ? "Your waves will be drawn on the Syntakt screen as well."
      : "The screen keeps the original pictures. Only the sound changes.");
  });

  el.resetAll.addEventListener("click", () => {
    if (!state.ops.length && !state.revertToFactory) { say(el.status, "You have not changed anything yet."); return; }
    askInline("Undo all " + state.ops.length + " of your changes here?",
      "Yes, undo them", () => {
        commit({ ops: [], revertToFactory: false });
        say(el.status, "All your changes here are gone. The waves are as they were in your file.");
      });
  });

  el.exportWav.addEventListener("click", () => {
    const b = currentBank();
    const all = new Float64Array(bank.FRAME_COUNT * 256);
    for (let k = 0; k < bank.FRAME_COUNT; k++) all.set(bank.previewCycle(section, b, k), k * 256);
    const url = saveBlob(new Blob([encodeWavFloat32(all, 48000)], { type: "audio/wav" }), "sychord_frames_current.wav");
    ui.objectUrls.push(url);
    say(el.status, "All 32 waves were saved to your download folder as one WAV file.");
  });

  function clampHarm(v) {
    return Math.max(MIN_HARMONICS, Math.min(MAX_HARMONICS, Math.round(Number(v) || DEFAULT_HARMONICS)));
  }

  // ---- the per-wave band limit ------------------------------------------------------------------

  el.harm.addEventListener("input", () => {
    const i = bank.opIndexForSlot(opsOf(state), ui.sel);
    if (i < 0) return;
    const real = indexInAll(i);
    commit({ ops: bank.setOpHarmonics(state.ops, real, clampHarm(el.harm.value)) });
  });

  /** opsOf() may hide frame-0 operations: map an index in the visible list back to state.ops. */
  function indexInAll(i) {
    const visible = opsOf(state);
    return state.ops.indexOf(visible[i]);
  }

  // ---- navigation -----------------------------------------------------------------------------------

  el.prev.addEventListener("click", () => select(Math.max(0, ui.sel - 1), true));
  el.next.addEventListener("click", () => select(Math.min(bank.FRAME_COUNT - 1, ui.sel + 1), true));
  for (const r of el.modes.querySelectorAll('input[name="wt-mode"]')) r.addEventListener("change", render);

  // ---- rendering ------------------------------------------------------------------------------------

  function render() {
    const b = currentBank();
    for (let k = 0; k < bank.FRAME_COUNT; k++) {
      const st = slotState(b, k);
      const cell = ui.cells[k];
      cell.className = "cell" +
        (st === "custom" || st === "image" ? " is-custom" : st === "moved" ? " is-moved" : "") +
        (k === 0 && !state.allowFrame0 ? " is-locked" : "") +
        (k === ui.sel ? " is-selected" : "");
      cell.tabIndex = k === ui.sel ? 0 : -1;
      const label = slotLabel(b, k, st);
      cell.setAttribute("aria-label", label);
      cell.title = label;
      cell.innerHTML = waveSvg(bank.previewCycle(section, b, k), 64);
    }
    renderEditor(b);
    renderChanges();
  }

  function renderEditor(b) {
    const k = ui.sel;
    const st = slotState(b, k);
    const e = b[k];
    const locked = k === 0 && !state.allowFrame0;

    el.big.className = "big" + (st === "custom" || st === "image" ? " is-custom" : st === "moved" ? " is-moved" : "");
    el.big.innerHTML = waveSvg(bank.previewCycle(section, b, k), 257);

    el.title.textContent = "WAVE " + bank.waveValue(k);
    el.title.append(node("small", null, " (wave " + (k + 1) + " of 32)"));

    el.state.className = "state" + (st === "custom" || st === "image" ? " is-custom" : st === "moved" ? " is-moved" : "");
    el.state.textContent =
      st === "custom" ? "your wave: " + e.name
        : st === "moved" ? "original wave, moved up from WAVE " + bank.waveValue(e.from)
          : st === "image" ? "already changed in your image"
            : k === 0 ? "a sine other machines share" + (locked ? " - locked" : "")
              : "original wave";

    el.loadWav.disabled = locked;
    for (const r of el.modes.querySelectorAll('input[name="wt-mode"]')) r.disabled = locked || k === 0;
    const mode = modeNow();
    el.consequence.textContent = locked
      ? "WAVE 0 is locked. Open Settings above to allow changing it."
      : k === 0
        ? "WAVE 0 can only be replaced. Other machines change with it."
        : mode === "insert"
          ? "The waves above this one move up a step. The last one is dropped."
          : "Only this wave changes. Its neighbours morph into it.";

    const opIndex = bank.opIndexForSlot(opsOf(state), k);
    el.limiter.hidden = opIndex < 0;
    if (opIndex >= 0) {
      const op = opsOf(state)[opIndex];
      const r = bank.opEntry(op).report;
      el.harm.value = String(op.harmonics);
      el.harmOut.textContent = String(op.harmonics);
      el.harmNote.textContent = "Keeps " + r.harmonicsKept + " harmonics. Lower this if the wave sounds " +
        "harsh on high notes.";
      el.harmDetail.textContent = r.inputLength + " samples in, " + pct(r.discardedEnergyPct) +
        " of the energy discarded above the limit.";
    }

    el.prev.disabled = k === 0;
    el.next.disabled = k === bank.FRAME_COUNT - 1;
  }

  function renderChanges() {
    const out = document.createDocumentFragment();

    if (state.revertToFactory && stockSection) {
      const row = node("div", "chg is-base");
      row.append(node("span", "n", ""));
      const body = node("span");
      body.append(node("strong", null, "All waves go back to the original ones"));
      body.append(node("small", null, " your changes below are applied on top"));
      row.append(body);
      const buttons = node("span", "buttons");
      const undo = node("button", "btn btn-small", "Undo");
      undo.type = "button";
      undo.addEventListener("click", () => {
        commit({ revertToFactory: false });
        say(el.status, "The waves already in your file are kept again.");
      });
      buttons.append(undo);
      row.append(buttons);
      out.append(row);
    } else if (baseChanged.length && stockSection) {
      const row = node("div", "chg is-base");
      row.append(node("span", "n", ""));
      const body = node("span");
      body.append(node("strong", null, "Already changed in your file: " +
        list(baseChanged.map((k) => "WAVE " + bank.waveValue(k)))));
      body.append(node("small", null, " kept exactly as they are unless you change them"));
      row.append(body);
      const buttons = node("span", "buttons");
      const revert = node("button", "btn btn-small", "Put the original waves back");
      revert.type = "button";
      revert.addEventListener("click", () => {
        askInline("Put all 32 waves back to the original ones? Your changes in the list below are kept " +
          "and applied on top.", "Yes, use the original waves", () => {
          commit({ revertToFactory: true });
          say(el.status, "The original waves will be used when you build. Your own changes stay on top.");
        });
      });
      buttons.append(revert);
      row.append(buttons);
      out.append(row);
    }

    const visible = opsOf(state);
    visible.forEach((op, i) => {
      const row = node("div", "chg");
      row.append(node("span", "n", i + 1 + "."));
      const body = node("span");
      body.append(node("strong", null, "WAVE " + bank.waveValue(op.frame)));
      body.append(document.createTextNode(op.mode === "insert" ? " insert " : " replace with "));
      body.append(node("strong", null, op.name));
      body.append(node("small", null, " " + op.harmonics + " harmonics"));
      if (op.mode === "insert") body.append(node("small", null, " - the waves above move up one step"));
      row.append(body);
      const buttons = node("span", "buttons");
      const show = node("button", "btn btn-small", "Go to it");
      show.type = "button";
      show.addEventListener("click", () => select(op.frame, true));
      const rm = node("button", "btn btn-small", "Undo");
      rm.type = "button";
      rm.setAttribute("aria-label", "Undo change " + (i + 1) + ", WAVE " + bank.waveValue(op.frame) + ", " + op.name);
      rm.addEventListener("click", () => {
        commit({ ops: bank.removeOp(state.ops, indexInAll(i)) });
        say(el.status, "Change " + (i + 1) + " undone. Everything else stays as it was.");
      });
      buttons.append(show, rm);
      row.append(buttons);
      out.append(row);
    });

    if (!out.childNodes.length) {
      out.append(node("div", "empty", "Nothing yet. Pick a wave above and load a WAV file into it."));
    }
    el.chgList.replaceChildren(out);
    el.chgCount.textContent = visible.length ? "(" + visible.length + ")" : "";
  }

  // ---- boot -------------------------------------------------------------------------------------------

  el.harm.min = String(MIN_HARMONICS);
  el.harm.max = String(MAX_HARMONICS);
  el.defharm.min = String(MIN_HARMONICS);
  el.defharm.max = String(MAX_HARMONICS);
  el.defharm.value = String(clampHarm(state.defaultHarmonics));
  el.defharmOut.textContent = String(clampHarm(state.defaultHarmonics));
  el.unlock0.checked = !!state.allowFrame0;
  el.pics.checked = drawsPictures(state);
  const firstOp = opsOf(state)[0];
  ui.sel = firstOp ? firstOp.frame : 1;
  render();

  view = { container, ui };
  return { focus: () => ui.cells[ui.sel] && ui.cells[ui.sel].focus() };
}

export function unmount() {
  if (!view) return;
  for (const url of view.ui.objectUrls) URL.revokeObjectURL(url);
  view.container.replaceChildren();
  view = null;
}

export const tool = {
  id: MOD_ID,
  createState,
  summarise,
  contribute,
  changedFrames,
  mount,
  unmount,
};
