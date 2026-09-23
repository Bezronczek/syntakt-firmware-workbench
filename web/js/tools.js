// The registry of tool modules. Adding a tool to this site is three edits:
//   1. one entry in MODS (js/mods.js) declaring the byte regions it may write,
//   2. one module in js/tools/ exporting `tool` (the plug-in interface below),
//   3. one line here, and then `node web/dev/make-fingerprints.mjs` because the regions changed.
//
// The plug-in interface, which the workbench knows in full and nothing else about a tool:
//
//   tool.id                                   must match an id in MODS
//   tool.createState()                        -> plain, structured-clone-able state
//   tool.summarise(state, ctx)                -> [string]  lines for the queue; [] = nothing queued
//   tool.contribute(state, ctx)               -> [{ section, bytes, note? }] built on ctx.baseParsed; [] = nothing
//                                             `bytes` is the section as the device sees it: the
//                                             decompressed bytes of a compressed section, always
//                                             exactly as long as the section it replaces.
//                                             `note` is one line for the build checklist.
//   tool.mount(container, state, ctx, onChange)  render the view; onChange(next) on every edit
//   tool.unmount()                            drop listeners and object URLs
//
//   ctx = { baseParsed, stockParsed | null, present: [{ id, title, regions }] }
//
// The workbench owns the image, the queue, the Build and the download; a tool only ever queues.

export const TOOLS = {
  "sychord-waves": () => import("./tools/sychord-waves.js"),
  "lfo-dv": () => import("./tools/lfo-dv.js"),
};

export const TOOL_IDS = Object.keys(TOOLS);

/** Load every registered tool module once. The site is small; one await at boot is enough. */
export async function loadTools(registry = TOOLS) {
  const out = new Map();
  for (const [id, load] of Object.entries(registry)) {
    const mod = await load();
    const tool = mod.tool || mod.default;
    if (!tool || tool.id !== id) throw new Error("tool module " + id + " does not export a matching `tool`");
    out.set(id, tool);
  }
  return out;
}
