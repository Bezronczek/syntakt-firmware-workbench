// The build, off the main thread. A build that rewrites a compressed section packs several
// megabytes at level 3, which takes about twenty seconds; in a worker the page stays usable
// while that happens.
//
// It holds no logic of its own: it parses the image the page sends and calls the same
// workbench.buildImage the Node tests call, so there is one build path, not two. The page
// falls back to calling buildImage itself when a browser has no module workers.
//
// In:  { fileBytes, contributions: [{ modId, section, bytes }], level }
// Out: { progress: { phase, section, fraction } } while packing, then
//      { ok: true, file, report } or { ok: false, error }

import * as fw from "./syntakt-fw.js";
import * as wb from "./workbench.js";

self.addEventListener("message", async (ev) => {
  const { fileBytes, contributions, level } = ev.data || {};
  try {
    const parsed = fw.parseSyx(fileBytes);
    const onProgress = (progress) => self.postMessage({ progress });
    const res = await wb.buildImage(parsed, contributions, undefined, undefined, { level, onProgress });
    self.postMessage({ ok: true, file: res.file, report: res.report }, [res.file.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
});
