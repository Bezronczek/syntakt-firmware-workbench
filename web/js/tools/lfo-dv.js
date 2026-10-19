// The Deja Vu LFO tool (the shape DV-H), as a workbench plug-in (see js/tools.js for the interface).
// State: { add: boolean }. Every byte-level decision lives in ../lfo-dv.js, which the Node tests drive.
// DRAFT COPY: the user-facing strings below are drafts for the author to rewrite (web/COPY-GUIDE.md).

import * as fw from "../syntakt-fw.js";
import * as dv from "../lfo-dv.js";
import { node } from "../site.js";

const MOD_ID = "lfo-dv";
const ADD_LINE = "Add the LFO shape DV-H after RND.";

export function createState() {
  return { add: false };
}

const present = (ctx) => (ctx && ctx.present || []).some((m) => m.id === MOD_ID);

export function summarise(state, ctx) {
  return state && state.add && !present(ctx) ? [ADD_LINE] : [];
}

export function contribute(state, ctx) {
  if (!summarise(state, ctx).length) return [];
  const raw = fw.getSectionRaw(ctx.baseParsed, dv.SECTION);
  if (dv.isPatched(raw)) return [];
  return [{ section: dv.SECTION, bytes: dv.buildSection(raw), note: "LFO shape DV-H added" }];
}

const VIEW = `
<p class="lead-line">Add a new LFO shape to your file.</p>
<p class="hint small">It comes after RND on the WAVE knob of every LFO. Its behaviour is inspired by the Deja Vu control of Mutable Instruments Marbles. Nothing is written here: you build your file on the workbench.</p>
<div class="tool-note" data-x="note" hidden></div>
<dl class="facts">
  <dt>DV-H</dt><dd>A loop of random levels. Every note moves it one step on; between notes the level holds.</dd>
  <dt>SPD</dt><dd>Length of the loop, 1 to 32 steps. Negative values play the loop backwards.</dd>
  <dt>SPH</dt><dd>0: new values all the time. 64: the loop repeats. 127: the same values in a new order.</dd>
  <dt>MODE</dt><dd>No function for this shape; the cell shows two dashes. MULT has no function either.</dd>
</dl>
<p class="go"><button type="button" class="btn btn-primary" data-x="toggle"></button></p>
<p class="status" data-x="status" aria-live="polite"></p>
`;

let cleanup = null;

export function mount(container, initial, ctx, onChange) {
  unmount();
  container.innerHTML = VIEW;
  const el = {};
  for (const n of container.querySelectorAll("[data-x]")) el[n.dataset.x] = n;
  let state = { ...createState(), ...(initial || {}) };

  if (present(ctx)) {
    el.note.hidden = false;
    el.note.append(node("p", null, "Your file already has DV-H. There is nothing to add."));
    el.toggle.hidden = true;
    return;
  }

  function render() {
    el.toggle.textContent = state.add ? "Remove from the build" : "Add DV-H";
    el.toggle.classList.toggle("btn-primary", !state.add);
    el.status.textContent = state.add ? "Added. Go back to the workbench and build your file." : "";
  }
  const onClick = () => {
    state = { ...state, add: !state.add };
    onChange(state);
    render();
  };
  el.toggle.addEventListener("click", onClick);
  cleanup = () => el.toggle.removeEventListener("click", onClick);
  render();
}

export function unmount() {
  if (cleanup) cleanup();
  cleanup = null;
}

export const tool = { id: MOD_ID, createState, summarise, contribute, mount, unmount };
