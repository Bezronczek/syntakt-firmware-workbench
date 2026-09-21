// Small DOM helpers shared by the workbench and by every tool view.
//
// Nothing here runs on import: the module is safe to load in Node, which is what lets the Node
// tests import a tool module (and with it its view code) without a DOM. Everything that needs a
// document is inside a function that the page calls.

/** node("p", "hint", "text") -- the three-argument element builder used everywhere. */
export function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Write a status line. `kind` is "", "ok" or "bad". */
export function say(target, text, kind) {
  if (!target) return;
  target.textContent = text;
  target.className = "status" + (kind ? " " + kind : "");
}

/** Drag and drop plumbing for one target; `onFiles` gets a File array. */
export function wireDrop(target, onFiles) {
  const over = (on) => (e) => { e.preventDefault(); target.classList.toggle("is-over", on); };
  target.addEventListener("dragenter", over(true));
  target.addEventListener("dragover", over(true));
  target.addEventListener("dragleave", over(false));
  target.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    target.classList.remove("is-over");
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (files.length) onFiles(files);
  });
}

/** A missed drop must never navigate the page away and lose the loaded firmware. */
export function guardStrayDrops(win = window) {
  for (const type of ["dragover", "drop"]) win.addEventListener(type, (e) => e.preventDefault());
}

/** Hand a blob to the browser's download machinery; returns the object URL so it can be revoked. */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return url;
}

/** Move focus to a heading after a route change, without adding it to the tab order for good. */
export function focusHeading(heading) {
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: "start", behavior: "auto" });
}
