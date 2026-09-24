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

A build that rewrites a **compressed** section has to pack it again: at level 3, the only level
proven to reproduce the chain that was flashed on hardware, that is about 20 seconds for the MAIN OS
section. The page says so while it works and runs the build in `js/build-worker.js` when the browser
has module workers, so the tab stays responsive; without them it runs on the main thread. Both call
the same `buildImage`.

Your file and your changes are saved in this browser (IndexedDB) as you work, so a reload does not
lose them. **Forget my files** erases them.

---

## How mods combine

Every mod declares, up front, the byte ranges it may write, as `[start, end)` offsets inside a
firmware section (`js/mods.js`) - always inside the section **as the device sees it**, so for a
compressed section the offsets are into its decompressed bytes. The rules, deliberately the weakest
useful guarantee:

- two mods may be combined only if their regions are disjoint;
- an image may differ from the official file only inside regions of known mods;
- no mod changes the length of a section's content, so every offset inside a section stays put.

What a compressed section costs once it is packed is nobody's business but the codec's: a section
that is written again almost never packs to its old length, so the sections after it move and the
file changes size. The container is therefore compared structurally instead - same sections in the
same order, the same header and table apart from the offset and length fields a rebuild rewrites,
zero padding, and the layout rule (`mods.containerShell`, `layoutIsRight`, `paddingIsClean`).
An image that only went through that rebuild has the official content but not the official bytes:
`verifyImage` returns `ok: true, isStock: false, recompressed: true, mods: []`, and it is a perfectly
good base to build on. `isStock` stays reserved for the official file byte for byte, because that is
what it is used for: deciding whether a file can serve as the factory reference.

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
  contribute(state, ctx),                   // -> [{ section, bytes, note? }]; [] if nothing queued
  mount(container, state, ctx, onChange),   // render the view; onChange(next) on every edit
  unmount(),                                // drop listeners and object URLs
};
// ctx = { baseParsed, stockParsed | null, present: [{ id, title, regions }] }
```

A contribution may target a **compressed** section. `bytes` is then the section as the device sees
it - `fw.getSectionRaw(ctx.baseParsed, id)` long, decompressed - and the workbench packs it again on
the way out. `note`, when present, is one plain line added to the build checklist.

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
- **Draw my waves on the Syntakt screen too** (on by default) also rewrites the 128 small pictures
  the instrument draws in the WAVE cell, so the screen shows the shapes that are actually playing.
  Checked on an instrument on 2026-09-22. Switching it off gives exactly the earlier behaviour
  (section 7 only, same file size).

- **Or make a chord wave** (under the load button) queues a chord built by `js/chord-waves.js` as an
  ordinary operation: same Replace / Insert, same list, same Undo. Its band limit is raised to the
  chord's top harmonic.
- A **WaftWave bank (.json)** or a **ZIP of WAVs**, dropped on a wave or loaded with the button, is
  read by `js/bank-import.js` and placed from that wave up after one question; when it has more waves
  than fit, the question offers "spread evenly" and "take the first ones".

### How the pictures are written

`js/wave-picture.js` renders one 17x17, 1-bpp picture (68 bytes) per WAVE value from the 32 key-frame
cycles, morphing between frames the way the machine does. `js/sychord-picture-map.js` says where they
live in the decompressed MAIN OS section: 125 blocks in one run, plus three WAVE values that own no
block and reach a neighbour's through a four-byte pointer in code, which the tool repoints so those
values show the right shape too. The tool writes all of that into a copy of the decompressed section
and hands it over as a second contribution; the workbench takes only the declared bytes, as always.

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
node web/test/wave-picture.test.mjs    # the screen pictures; the factory comparison needs work/
node web/test/codec.test.mjs           # .syx codec, against golden files in work/
node web/test/aplib.test.mjs           # the compressed-section codec, against the C tool (~45 s)
node web/test/container.test.mjs       # replacing a compressed section, byte for byte (~40 s)
node web/test/mods.test.mjs            # registry, compatibility, image analysis
node web/test/workbench.test.mjs       # stock-less verification, fingerprints, multi-mod build
node web/test/firmware-input.test.mjs  # what a dropped file is, one or two at a time, the messages
node web/test/session.test.mjs         # autosave, restore, re-verification, Forget (in-memory store)
node web/test/e2e.test.mjs             # the plug-in interface end to end, against work/ (~25 s)
```

`e2e` runs one full level-3 build, the way the page builds; everywhere else the tests pass
`{ level: 0 }` to `buildImage`, because what the packed stream looks like is `container.test.mjs`'s
job and packing is all the time.

Everything except `dsp` reads firmware from `work/`, which is **never** part of this repository.
Supply your own copy there to run them.

## Layout

```
web/
  index.html              the whole site: workbench view + tool view, hash routed
  sychord-waves.html      redirect to index.html#/sychord-waves
  css/style.css           all the styling
  js/syntakt-fw.js        .syx codec + container rebuild + wave bank access (provided, do not modify)
  js/aplib.js             the compressed-section codec (depack / pack), a port of the C tool's
  js/mods.js              mod registry + compatibility engine + the container checks
  js/workbench.js         verify an image without the official file; build from contributions
  js/build-worker.js      the same build, off the main thread when the browser has module workers
  js/fingerprints.js      GENERATED digests of the official firmware (no firmware bytes)
  js/firmware-input.js    what a dropped file is, and the sentences about it; pure, Node-testable
  js/session.js           the loaded files, the tool states, autosave; pure, Node-testable
  js/store.js             IndexedDB wrapper + in-memory fake, same four methods
  js/router.js            #/ and #/<tool id>
  js/tools.js             the registry of tool modules
  js/tools/sychord-waves.js  the wave tool: plug-in interface + its view
  js/tools/lfo-dv.js      the Deja Vu LFO tool: plug-in interface + its view
  js/bank.js              wave operations list and building section 7; pure, Node-testable
  js/wave-dsp.js          WAV decoding and single-cycle conditioning; pure, Node-testable
  js/wave-picture.js      the 17x17 pictures the screen draws, rendered from cycles; pure
  js/chord-waves.js       chord waves: tones on whole-number harmonics, low-peak phases; pure
  js/bank-import.js       WaftWave bank (.json) and ZIP-of-WAVs reading; pure, Node-testable
  js/sychord-picture-map.js  where those pictures live in the decompressed MAIN OS section
  js/lfo-dv.js            the Deja Vu LFO patch (shapes DV-F, DV-T) on the decompressed MAIN OS section; pure
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

## `js/aplib.js` - the compressed-section codec

Most sections of an Elektron OS container are not stored raw: they are LZ77 streams with
interlaced Elias-gamma codes (an aPLib variant), each behind an 8-byte header
`[u32 stream length BE][u32 stream byte-sum BE]`. `js/aplib.js` reads and writes them:

- `depack(section)` - whole section in, raw bytes out. It verifies the header length and
  byte-sum before decoding and throws a readable error on anything malformed, so a damaged
  file is rejected rather than quietly decoded into garbage.
- `pack(raw, level = 3)` - raw bytes in, header + stream out. Levels 0..3 trade time for
  size (how many match candidates the cost-optimal parse examines per position).
- `streamSum(bytes)`, `streamStats(section)` and the format constants.

It is a direct port of `aplib.c` from **mischa85's elektron-firmware-tool** (Marcel Bierling,
MIT licensed) - the C chain whose output is proven on hardware. Same dependency-free, works in
the browser and in Node.

`node web/test/aplib.test.mjs` checks it against that tool's own files in `work/aplib-golden/`
(never committed, supply your own): all four stock sections and the tool's level-3
recompression of MAIN OS depack byte-identically, every level round-trips, and `pack(MAIN OS, 3)`
comes out **byte-identical** to the C tool's level-3 section - which is the evidence that a
stream written here is one the device's depacker accepts. The run takes about 40 seconds,
most of it packing MAIN OS at level 3.

## `js/syntakt-fw.js` - replacing a whole section

Beyond the same-length `replaceRawSection`, the codec can replace a section whose stored
length changes - including a compressed one, which almost never packs back to the same size:

- `isCompressed(parsed, id)` - whether the section is stored as an aPLib stream. Nothing in
  the table says so, so this is derived the way the reference C tool derives it: the stored
  bytes are tried against the depacker, and a section that decodes is compressed. No
  hard-coded list, so it does not assume one particular OS build.
- `getSectionRaw(parsed, id)` - the section as the device sees it: decompressed when the
  section is compressed, the stored bytes when it is not.
- `replaceSection(parsed, id, bytes, { level = 3, onProgress })` - a **new parsed image** with that
  section holding `bytes`, compressed first when the section is compressed. `onProgress(fraction)`
  is called every 64 KB of packing with 0..1 and once with 1 at the end; `workbench.buildImage`
  forwards it as `options.onProgress({ phase: "pack", section, fraction })`, and the page turns it
  into the bar under the Build button (the worker relays it as `{ progress }` messages). **The stored
  length may change**: the container is rebuilt from its section table, so later sections
  move, the offsets and lengths in the table, the container size and every checksum are
  recomputed, and the SysEx transport is re-encoded from scratch. The result is produced by
  parsing the rebuilt file, so it is verified before it is returned.
- `buildSyx(parsed)` - the `.syx` file bytes. An untouched parsed image round-trips to the
  file it came from, byte for byte.

`level` is the aPLib effort 0..3. **Level 3 reproduces the reference tool's output byte for
byte**, so an image built here is the image that chain would have built; it costs about 16
seconds for the largest section. Lower levels are much faster and slightly larger, and the
device accepts them just as well.

`node web/test/container.test.mjs` proves it against the C chain's own images in `work/`
(never committed, supply your own): recompressing the largest section at level 3 reproduces
that tool's repack **byte-identically**, as does the same repack with one byte changed in the
decompressed section first - both of which booted on hardware. It also checks the round trip,
that no other section moves a byte, that the rebuilt table follows the layout rule, and that
a length change shifts everything after it. The run takes about 40 seconds.

`mods.js` and `workbench.js` use this path: a mod may declare regions in a compressed section
(the SY CHORD tool does, for the pictures on the screen), a contribution to one carries the
decompressed bytes, and the build packs them again at level 3. See "How mods combine" for what
that means for the size of the file and for how an image is recognised afterwards.
