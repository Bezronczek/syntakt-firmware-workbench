// DV LFO shapes (js/lfo-dv.js). Needs the (never committed) official firmware in work/; the build it
// reproduces is DV version 2 (24 September 2026); its bytes are the DV part of the image checked on a real Syntakt
// (compared by SHA-256 only).
// Run from the project root:  node web/test/lfo-dv.test.mjs
import { readFileSync, existsSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";
import * as dv from "../js/lfo-dv.js";

let failed = 0;
const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) failed++; };

// sha256 of the raw section 3 of EXPERIMENT_dv2.syx (DV v2, 2026-09-24; emulator gate + hardware inside the LFO3+DV image)
const CHECKED_SECTION3 = "85c2f3c7e81951a41a17970605a38717602c20a811115169fb5b410d957c3b2e";

const STOCK = "work/Syntakt_OS1.41.syx";
if (!existsSync(STOCK)) { console.log("SKIP  lfo-dv tests: " + STOCK + " missing"); process.exit(0); }
const stock = fw.parseSyx(new Uint8Array(readFileSync(STOCK)));
const raw = fw.getSectionRaw(stock, dv.SECTION);
const built = dv.buildSection(raw);

ok("same length as the official section", built.length === raw.length);
ok("the official section is left untouched", !dv.isPatched(raw));
ok("isPatched() sees the patch", dv.isPatched(built));

// every changed byte lies inside a declared region, and the regions do not overlap
let outside = 0, changed = 0;
for (let i = 0; i < raw.length; i++) if (raw[i] !== built[i]) {
  changed++;
  if (!dv.REGIONS.some((r) => i >= r.start && i < r.end)) outside++;
}
ok(`all ${changed} changed bytes are inside REGIONS`, changed > 0 && outside === 0);
ok("REGIONS are disjoint", dv.REGIONS.every((r, i) => i === 0 || dv.REGIONS[i - 1].end <= r.start));
ok("the two blank runs are blank in the official file", dv.REGIONS.filter((r) => r.end - r.start >= 0x500)
  .every((r) => raw.subarray(r.start, r.end).every((b) => b === 0)));

// bit-identical to the image that was checked on the device
const digest = await fw.sha256hex(built);
const golden = "work/current/EXPERIMENT_dv2.syx";
if (existsSync(golden)) {
  const g = await fw.sha256hex(fw.getSectionRaw(fw.parseSyx(new Uint8Array(readFileSync(golden))), dv.SECTION));
  ok("same section 3 as the hardware-checked image (file)", digest === g);
  if (digest === g && g !== CHECKED_SECTION3) console.log("NOTE  CHECKED_SECTION3 should be " + g);
} else ok("same section 3 as the hardware-checked image (digest)", digest === CHECKED_SECTION3);


if (failed) { console.log(failed + " failed"); process.exit(1); }
console.log("all passed");
