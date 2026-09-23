// The Deja Vu LFO tool (shapes DV-F and DV-T), as a workbench plug-in (see js/tools.js for the interface).
// State: { add: boolean }. Every byte-level decision lives in ../lfo-dv.js, which the Node tests drive.
// DRAFT COPY: the user-facing strings below are drafts for the author to rewrite (web/COPY-GUIDE.md).

import * as fw from "../syntakt-fw.js";
import * as dv from "../lfo-dv.js";
import { node } from "../site.js";

const MOD_ID = "lfo-dv";
const ADD_LINE = "Add two LFO shapes, DV-F and DV-T, after RND.";

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
  return [{ section: dv.SECTION, bytes: dv.buildSection(raw), note: "LFO shapes DV-F and DV-T added" }];
}

const VIEW = `
<p class="lead-line">Add two new LFO shapes to your file.</p>
<p class="hint small">They come after RND on the WAVE knob of every LFO. Their behaviour is inspired by the Deja Vu control of Mutable Instruments Marbles. Nothing is written here: you build your file on the workbench.</p>
<div class="tool-note" data-x="note" hidden></div>
<dl class="facts">
  <dt>DV-F</dt><dd>A loop of random steps that keeps running on its own.</dd>
  <dt>DV-T</dt><dd>The same loop, started again by every note.</dd>
  <dt>SPH</dt><dd>0: new values all the time. 64: the loop repeats. 127: the same values in a new order.</dd>
  <dt>MODE</dt><dd>Length of the loop: 2, 4, 8, 16 or 32 steps. The MODE cell shows the number.</dd>
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
    el.note.append(node("p", null, "Your file already has DV-F and DV-T. There is nothing to add."));
    el.toggle.hidden = true;
    return;
  }

  function render() {
    el.toggle.textContent = state.add ? "Remove from the build" : "Add DV-F and DV-T";
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
