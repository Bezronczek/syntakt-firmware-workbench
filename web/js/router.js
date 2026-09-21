// A hash router in thirty lines. Routes:
//   #/                 the workbench
//   #/<tool id>        one tool view
// Nothing else exists, so anything unrecognised falls back to the workbench. The hash is used
// rather than the History API because the site has to work from a plain static file server
// (and from file:// while it is being written) with no rewrite rules at all.

/** Pure: "#/sychord-waves" -> { view: "tool", toolId: "sychord-waves" }. */
export function parseRoute(hash, knownTools = []) {
  const path = String(hash || "").replace(/^#/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!path) return { view: "workbench", toolId: null };
  const id = decodeURIComponent(path.split("/")[0]);
  if (knownTools.includes(id)) return { view: "tool", toolId: id };
  return { view: "workbench", toolId: null, unknown: id };
}

export const routeHash = (toolId) => (toolId ? "#/" + encodeURIComponent(toolId) : "#/");

/**
 * @param knownTools ids that have a view
 * @param onRoute    called with the parsed route on every change, and once at start()
 */
export function createRouter(knownTools, onRoute) {
  let current = null;
  const handle = () => {
    const next = parseRoute(location.hash, knownTools);
    const key = next.view + ":" + (next.toolId || "");
    if (key === current) return;
    current = key;
    onRoute(next);
  };
  return {
    start() {
      window.addEventListener("hashchange", handle);
      handle();
    },
    /** Navigate, adding a history entry, so the browser's back button returns where it should. */
    go(toolId) {
      const next = routeHash(toolId);
      if (location.hash === next) handle();
      else location.hash = next;
    },
    current: () => current,
  };
}
