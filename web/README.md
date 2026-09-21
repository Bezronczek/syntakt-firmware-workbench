# Syntakt Firmware Workbench

A static, client-side **workbench** that builds modified Elektron Syntakt OS images from a firmware
file that **you** supply.

You load your file once, open the tools you want, queue what they should change, and build one image
at the end. Nothing is uploaded, nothing is downloaded from the network, and no page can talk to an
instrument. The site reads the `.syx` you choose, edits it in the browser tab, and hands you a
new `.syx`.

**Unofficial. Not affiliated with, endorsed by or supported by Elektron.**

The whole site is one page with hash routes:

| Route                 | What it is                                                              |
| --------------------- | ----------------------------------------------------------------------- |
| `index.html#/`        | the workbench: your file, the tools, the queue, Build                   |
| `index.html#/sychord-waves` | the SY CHORD Wave Bank tool, as a view                            |
| `sychord-waves.html`  | a redirect to `index.html#/sychord-waves`, kept so old links still work |

`mockups.html` and `mockup-d.html` are throw-away UX studies with synthetic waves. They are kept for
reference and are deliberately not linked from the site.

`COPY-GUIDE.md` is the rule set for every string on the page: one imperative instruction per step,
the instrument's own vocabulary ("WAVE 120", not "frame 30"), everything technical under "Details".
Read it before changing any user-visible text.

---

## Safety first

Flashing modified firmware can leave the instrument unusable and voids the warranty. You do it
entirely at your own risk.

Before flashing anything, make sure you can put the official OS back:

1. Hold `FUNC` while powering the Syntakt on to reach the **Early Startup Menu**.
2. Choose **OS UPGRADE**.
3. Send the official `.syx` over a **MIDI DIN cable with a real MIDI interface** (not over USB).

The authors verified that path over MIDI DIN on OS 1.41, on one unit. Verify it on **your** unit,
with the official file, before you flash anything from here. Back up your projects with Elektron
Transfer first.

---

## Supported firmware

**Syntakt OS 1.41 only.** Every offset used here was found by reading that exact build; another OS
version is compiled differently, so the same offsets would land in the middle of something else. A
file that is not OS 1.41 is refused rather than patched blindly.

---

## The flow

1. **Load one file.** Either the official `Syntakt_OS1.41.syx`, or an image you built here earlier.
   `workbench.verifyImage()` decides which it is **without needing the official file**, by comparing
   the image against SHA-256 fingerprints of the official firmware (`js/fingerprints.js`: digests
   only, never firmware bytes). An image it cannot account for is refused, with the sections listed.
2. **Recommended: add the official file as well.** You can drop both files at once, in any order; the
   site sorts them out by what they verify as. The official file is never required to queue or to
   build, but with it a tool can show which parts of your image are already changed and can put the
   original content back. When the file you loaded *is* the official one, it is its own reference and
   no recommendation is shown.
3. **Queue changes in tools.** A tool never writes a file. It edits its own small state object and
   hands the workbench a rewritten copy of a firmware section when asked.
4. **Build once.** `workbench.buildImage()` takes, from each contribution, only the bytes inside that
   mod's declared regions, merges several mods per section, refuses conflicts, recomputes every
   checksum and verifies the result. Then the download is offered.

Your file and your changes are saved in this browser (IndexedDB) as you work, so a reload does not
lose them. **Forget my files** erases them.

---

## How mods combine

Every mod declares, up front, the byte ranges it may write, as `[start, end)` offsets inside a
firmware section (`js/mods.js`). The rules, deliberately the weakest useful guarantee:

- two mods may be combined only if their regions are disjoint;
- an image may differ from the official file only inside regions of known mods;
- no mod changes the length of a section, so every offset stays put.

Disjoint bytes mean the mods cannot corrupt each other. It does **not** mean they make musical or
technical sense together, and the UI says so. A tool whose regions overlap something already in your
image, or already queued, is blocked before you can open it (`workbench.conflictsAmong`).

A contribution that writes outside its own regions has those bytes **dropped**, not applied, and the
build reports them as `strayWrites`. A buggy tool therefore cannot damage another mod's bytes.

---

## The mod plug-in interface

A tool is one module exporting an object; the workbench knows nothing about waves:

```js
export const tool = {
  id: "sychord-waves",                      // must exist in MODS
  createState(),                            // -> plain, structured-clone-able state
  summarise(state, ctx),                    // -> [string] for the queue; [] means nothing queued
  contribute(state, ctx),                   // -> [{ section, bytes }]; [] if nothing queued
  mount(container, state, ctx, onChange),   // render the view; onChange(next) on every edit
  unmount(),                                // drop listeners and object URLs
};
// ctx = { baseParsed, stockParsed | null, present: [{ id, title, regions }] }
```

`state` must be plain data (arrays, numbers, strings, typed arrays). It is stored with the structured
clone algorithm and handed back after a reload, so `serialise -> deserialise -> contribute` must
produce identical bytes; `test/e2e.test.mjs` asserts exactly that, `Float64Array` samples included.

`contribute` builds on `ctx.baseParsed`, which is the image the user loaded - it may already contain
this mod. `ctx.stockParsed` is the official file when the user added it, otherwise `null`; a tool
must work without it and say what it cannot do.

### Adding a mod

1. Add an entry to `MODS` in `js/mods.js`: `id`, `title`, `summary`, `touches`, and the `regions` it
   may write.
2. Write `js/tools/<id>.js` exporting `tool` as above. Keep byte-level logic in a DOM-free module so
   Node can test it; keep view code inside `mount`.
3. Register it in `js/tools.js`: `"<id>": () => import("./tools/<id>.js")`.
4. Regenerate the fingerprints, because the region list changed:
   `node web/dev/make-fingerprints.mjs` (it reads your own `work/Syntakt_OS1.41.syx` and writes
   digests only).
5. Run the tests. `test/workbench.test.mjs` fails if the fingerprints are stale, and
   `test/mods.test.mjs` fails if two mods overlap.

---

## What is stored in your browser

One record in an IndexedDB database called `syntakt-mods`, store `session`, key `workbench`:

- the bytes and name of the firmware image you loaded,
- the bytes and name of the official file, if you added one,
- one state object per tool, including the raw samples of every WAV you imported.

It is written about 300 ms after each change. Nothing else is stored, nothing leaves the browser, and
**Forget my files** deletes the whole database. Nothing that comes back from storage is trusted: a
restored image is parsed and verified again by the same code that checked it when you dropped it. An
image that no longer verifies is dropped with a message, and your queued changes are kept. If
IndexedDB is unavailable (private mode, blocked storage), the site works from memory and says so.

---

## The SY CHORD Wave Bank tool

Replaces the waves the `WAVE` parameter of SY CHORD (CC 18) morphs through. WAVE value `4 * k`
is exactly wave `k`; values in between interpolate linearly.

- 32 waves along the WAVE axis: click or use the arrow keys, drop a WAV on one, or load one from the
  editor. Colour says the state: dim = original, red = yours, amber = moved up by an insert.
- **Replace this wave** changes one wave. **Insert before it** moves everything above it up one step
  and drops the last one.
- **WAVE 0** is a sine shared with other machines. It is locked until you allow it in Settings, and an
  insert never moves it.
- **Brightness** (band limit, 8..127 harmonics, default 40) is stored per wave and re-derived from the
  original WAV samples, never from a previous result. The primary line is actionable; the discarded
  energy is under "Details".
- **Your changes** is an ordered list of operations replayed over the bank of the loaded image, so the
  same list always produces the same bytes and undoing one entry restores exactly the earlier result.
  A second Replace of the same wave supersedes the earlier one; an Insert is always appended.
- Waves that are only moved or kept are copied **byte for byte** from the loaded image, never
  re-normalised.
- With the official file loaded, the tool marks the waves that already differ from the original ones
  and offers **Put the original waves back**. Without it, it says so and hides both.

### Supported WAV formats

Uncompressed PCM at 8, 16, 24 or 32 bits, IEEE float at 32 or 64 bits, `WAVE_FORMAT_EXTENSIBLE`,
unknown chunks and odd-sized chunks. Only the first channel is used. Anything else is refused with a
readable message.

---

## Running it locally

There is no build step and there are no dependencies. Serve the folder over HTTP (ES modules do not
load from `file://`):

```sh
cd web
python web/dev/serve.py 8765
# then open http://localhost:8765/
```

## Running the tests

Plain Node, no test framework, run from the **project root**:

```sh
node web/test/dsp.test.mjs             # WAV decoding and cycle conditioning; no firmware needed
node web/test/codec.test.mjs           # .syx codec, against golden files in work/
node web/test/mods.test.mjs            # registry, compatibility, image analysis
node web/test/workbench.test.mjs       # stock-less verification, fingerprints, multi-mod build
node web/test/firmware-input.test.mjs  # what a dropped file is, one or two at a time, the messages
node web/test/session.test.mjs         # autosave, restore, re-verification, Forget (in-memory store)
node web/test/e2e.test.mjs             # the plug-in interface end to end, against work/
```

Everything except `dsp` reads firmware from `work/`, which is **never** part of this repository.
Supply your own copy there to run them.

## Layout

```
web/
  index.html              the whole site: workbench view + tool view, hash routed
  sychord-waves.html      redirect to index.html#/sychord-waves
  css/style.css           all the styling
  js/syntakt-fw.js        .syx codec + wave bank access (provided, do not modify)
  js/mods.js              mod registry + compatibility engine (do not change its logic)
  js/workbench.js         verify an image without the official file; build from contributions
  js/fingerprints.js      GENERATED digests of the official firmware (no firmware bytes)
  js/firmware-input.js    what a dropped file is, and the sentences about it; pure, Node-testable
  js/session.js           the loaded files, the tool states, autosave; pure, Node-testable
  js/store.js             IndexedDB wrapper + in-memory fake, same four methods
  js/router.js            #/ and #/<tool id>
  js/tools.js             the registry of tool modules
  js/tools/sychord-waves.js  the wave tool: plug-in interface + its view
  js/bank.js              wave operations list and building section 7; pure, Node-testable
  js/wave-dsp.js          WAV decoding and single-cycle conditioning; pure, Node-testable
  js/site.js              small DOM helpers, safe to import in Node
  js/app.js               the workbench UI: DOM only
  dev/make-fingerprints.mjs   regenerates js/fingerprints.js from your own official file
  test/                   plain Node test scripts
```

`app.js` and the `mount()` half of a tool hold no byte-level logic: it lives in `bank.js`,
`workbench.js` and `firmware-input.js`, so the page and the tests run exactly the same code.

## No Elektron data here

No firmware, no factory waveform, no excerpt of either is stored in this repository or in any page -
only SHA-256 digests in `js/fingerprints.js`, which cannot be turned back into firmware. Everything
shown in a tool is read at runtime from the file you supply.

## Prior art

- **mischa85 / elektron-firmware-tool** for the Elektron firmware container format.
- The **digikit** and **dn2_firmware_explore** projects, for showing that a browser-only,
  bring-your-own-firmware editor is the right shape for this.
