// Golden tests against files produced by the C tool chain that was proven on hardware.
// Needs the (never committed) firmware files in work/. Run from the project root:
//   node web/test/codec.test.mjs
import { readFileSync } from "node:fs";
import * as fw from "../js/syntakt-fw.js";

const rd = (p) => new Uint8Array(readFileSync(p));
let fails = 0;
const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fails++; };

const stock = rd("work/Syntakt_OS1.41.syx");
ok("stock sha256 is on the supported list", (await fw.sha256hex(stock)) in fw.SUPPORTED);
const p = fw.parseSyx(stock);
ok("version 1.41, 8 sections", p.version === "1.41" && p.sections.length === 8);
const s7 = fw.getSection(p, 7);
ok("section 7 length and sha256", s7.length === fw.WAVE.SECTION_LEN && (await fw.sha256hex(s7)) === fw.WAVE.SECTION_SHA256);
ok("round trip without changes is byte-identical", fw.diffRange(stock, fw.replaceRawSection(p, 7, s7)) === null);

const golden = rd("work/syntakt141_sychord_saw30.syx");
const built = fw.replaceRawSection(p, 7, rd("work/section_7_saw_at30.raw"));
ok("saw image equals the hardware-proven C build byte for byte", fw.diffRange(golden, built) === null);
ok("  ... and its sha256 starts 58a1a3bf", (await fw.sha256hex(built)).startsWith("58a1a3bf"));

const again = fw.parseSyx(built); // re-parsing verifies every checksum
ok("rebuilt image re-parses; sections other than 7 untouched",
  [1, 2, 3, 4, 5, 6, 8].every((id) => fw.diffRange(fw.getSection(p, id), fw.getSection(again, id)) === null));

const f0 = fw.readFrame(s7, 0), f1 = fw.readFrame(s7, 1);
ok("frame 0 is a sine; frame 1 starts like h1 + 0.5*h2", Math.abs(f0[64] - 1) < 1e-6 && Math.abs(f1[1] - 0.03778) < 1e-4);

const copy = s7.slice();
fw.writeFrame(copy, 5, fw.readFrame(s7, 5));
const a = fw.readFrame(s7, 5), b = fw.readFrame(copy, 5);
ok("writeFrame(readFrame(k)) reproduces a factory frame to 16-bit precision", a.every((x, i) => Math.abs(x - b[i]) < 2e-5));
const dr = fw.diffRange(s7, copy);
ok("  ... touching only that frame", dr === null || (dr[0] >= fw.frameOffset(5) && dr[1] < fw.frameOffset(5) + 257 * 4));

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
