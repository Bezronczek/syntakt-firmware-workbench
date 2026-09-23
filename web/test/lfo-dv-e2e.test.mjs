// End-to-end test of the DV LFO shapes tool through the workbench, the way the page uses it.
// Needs the (never committed) firmware files in work/. Run from the project root:
//   node web/test/lfo-dv-e2e.test.mjs
import { readFileSync, existsSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";
import * as wb from "../js/workbench.js";
import * as dv from "../js/lfo-dv.js";
import { tool } from "../js/tools/lfo-dv.js";
import { tool as waves } from "../js/tools/sychord-waves.js";

let fails = 0;
const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fails++; };
const rd = (p) => new Uint8Array(readFileSync(p));
const CHECKED_SECTION3 = "0d8b7f22a381b7cf5b8f970504fdbff461b974f79cb987c1d706d05b505651b2";   // lfo-dv.test.mjs
const CHECKED_FILE = "work/current/EXPERIMENT_lfo9_dvs.syx";

const stockBytes = rd("work/Syntakt_OS1.41.syx");
const stock = fw.parseSyx(stockBytes);
const ctxOf = async (parsed) => ({ baseParsed: parsed, stockParsed: null, present: (await wb.verifyImage(parsed)).mods });
const queue = (t, st, ctx) => t.contribute(st, ctx).map((p) => ({ modId: t.id, section: p.section, bytes: p.bytes }));

// a fresh state queues nothing
{
  const ctx = await ctxOf(stock);
  ok("fresh state is plain data", JSON.stringify(tool.createState()) === '{"add":false}');
  ok("fresh state: nothing to summarise or contribute", !tool.summarise(tool.createState(), ctx).length && !tool.contribute(tool.createState(), ctx).length);
}

// DV alone
let dvImage;
{
  const ctx = await ctxOf(stock);
  const st = { add: true };
  ok("summarise() says what it adds", tool.summarise(st, ctx).length === 1);
  const built = await wb.buildImage(stock, queue(tool, st, ctx));
  dvImage = fw.parseSyx(built.file);
  const v = await wb.verifyImage(dvImage);
  ok("the built image verifies, with the DV tool present", v.ok && v.mods.length === 1 && v.mods[0].id === "lfo-dv");
  ok("section 3 = the hardware-checked image", (await fw.sha256hex(fw.getSectionRaw(dvImage, dv.SECTION))) === CHECKED_SECTION3);
  if (existsSync(CHECKED_FILE))
    ok("the whole file = the file flashed and checked on 23 September 2026", (await fw.sha256hex(built.file)) === (await fw.sha256hex(rd(CHECKED_FILE))));
}

// on an image that already has DV: nothing to add
{
  const ctx = await ctxOf(dvImage);
  ok("already present: nothing queued", !tool.summarise({ add: true }, ctx).length && !tool.contribute({ add: true }, ctx).length);
}

// DV together with an SY CHORD wave
{
  const ctx = await ctxOf(stock);
  const saw = Float64Array.from({ length: 1024 }, (_, i) => (2 * i) / 1024 - 1);
  const ws = { ...waves.createState(), ops: [{ frame: 30, mode: "replace", name: "saw", samples: saw, harmonics: 40 }] };
  const parts = [...queue(tool, { add: true }, ctx), ...queue(waves, ws, ctx)];
  const built = await wb.buildImage(stock, parts);
  const img = fw.parseSyx(built.file);
  const v = await wb.verifyImage(img);
  ok("DV + SY CHORD waves build and verify", v.ok && v.mods.map((m) => m.id).sort().join() === "lfo-dv,sychord-waves");
  const s3 = fw.getSectionRaw(img, dv.SECTION), ref = fw.getSectionRaw(dvImage, dv.SECTION);
  ok("  ... every DV region is exactly as in the DV-only build",
    dv.REGIONS.every((r) => fw.diffRange(s3.subarray(r.start, r.end), ref.subarray(r.start, r.end)) === null));
}

if (fails) { console.log(fails + " FAILED"); process.exit(1); }
console.log("all passed");
