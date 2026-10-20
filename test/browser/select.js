// Serve the repository root, then call await selectTests.run() in a browser.
import { html, render, useState } from "../../web/lib/h.js";
import "../../web/lib/theme.js";
import { Select, Button, Field } from "../../web/ui/controls.js";
import { Dialog } from "../../web/ui/overlay.js";
import { Projects } from "../../web/views/Projects.js";
import { applyState, config, sources, actions } from "../../web/lib/store.js";

const choices = Array.from({ length: 50 }, (_, i) => [`p${i + 1}`, `Project ${i + 1}`]);
const root = document.querySelector("#root");
const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const key = (el, name) => el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
let changes = [];

function Fixture() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(["p1", "p1", "p50"]);
  const picker = (i, label) => html`<${Field} label=${label}><${Select} label=${label} value=${values[i]} options=${choices}
    onChange=${(v) => { changes.push([i, v]); setValues((previous) => previous.map((x, j) => j === i ? v : x)); }} /><//>`;
  return html`<main style="padding:24px;max-width:600px">
    <${Button} onClick=${() => setOpen(true)}>Add project<//>
    ${picker(2, "Outside")}
    <${Dialog} open=${open} onClose=${() => setOpen(false)} title="Add a project"
      actions=${html`<${Button} onClick=${() => setOpen(false)}>Cancel<//>`}>
      ${picker(0, "T3 project")}${picker(1, "Kaneo project")}
    <//>
  </main>`;
}

async function reset() {
  render(null, root);
  await pause();
  changes = [];
  render(html`<${Fixture} />`, root);
  await pause();
}

const trigger = (label) => [...root.querySelectorAll(".select > button")].find((b) => b.getAttribute("aria-label").startsWith(`${label}:`));
const popup = () => root.querySelector('[role="listbox"]');
const openDialog = async () => { root.querySelector("main > button").click(); await pause(); };
const openPicker = async (label) => { trigger(label).click(); await pause(); return popup(); };

function geometry(list, button, dialog) {
  const p = list.getBoundingClientRect(), t = button.getBoundingClientRect(), d = dialog?.getBoundingClientRect();
  assert(p.left >= 0 && p.right <= innerWidth + 1 && p.top >= 0 && p.bottom <= innerHeight + 1, "popup stays within viewport");
  assert(Math.abs(p.left - t.left) <= 1, "popup stays anchored horizontally");
  assert(Math.abs(p.top - t.bottom - 4) <= 1 || Math.abs(t.top - p.bottom - 4) <= 1, "popup stays anchored vertically");
  if (d) {
    assert(p.top < d.top || p.bottom > d.bottom, "popup uses space outside the compact dialog");
    const y = p.bottom > d.bottom ? Math.min(p.bottom - 8, Math.max(p.top + 8, d.bottom + 8)) : Math.max(p.top + 8, Math.min(p.bottom - 8, d.top - 8));
    assert(list.contains(document.elementFromPoint(p.left + p.width / 2, y)), "popup is hit-testable outside dialog bounds");
  }
}

async function run() {
  await reset();
  await openDialog();
  const dialog = root.querySelector("dialog");
  for (const label of ["T3 project", "Kaneo project"]) {
    const before = { height: dialog.scrollHeight, top: dialog.scrollTop };
    const list = await openPicker(label);
    assert(dialog.scrollHeight === before.height, "opening popup must not increase dialog scroll extent");
    geometry(list, trigger(label), dialog);
    list.scrollTop = list.scrollHeight;
    await pause();
    const last = list.lastElementChild, r = last.getBoundingClientRect(), p = list.getBoundingClientRect();
    assert(r.top >= p.top && r.bottom <= p.bottom, "popup scrolling reaches final choice");
    assert(last.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), "final choice can receive pointer input");
    last.click();
    await pause();
    assert(!popup() && trigger(label).textContent.trim() === "Project 50", "last choice updates picker and closes popup");
    assert(dialog.scrollTop === before.top, "menu scrolling does not scroll dialog");
    assert(changes.length === (label === "T3 project" ? 1 : 2), "each selection changes only its own picker once");
    const reopened = await openPicker(label);
    const selected = reopened.querySelector('[aria-selected="true"]').getBoundingClientRect();
    assert(selected.top >= reopened.getBoundingClientRect().top && selected.bottom <= reopened.getBoundingClientRect().bottom, "opening reveals selected choice");
    key(trigger(label), "Escape");
    await pause();
    assert(!popup() && dialog.open, "Escape closes popup before dialog");
  }
  await openPicker("T3 project");
  key(trigger("T3 project"), "End");
  await pause();
  const active = popup().querySelector('[data-active="true"]').getBoundingClientRect();
  assert(active.bottom <= popup().getBoundingClientRect().bottom && changes.length === 2, "keyboard navigation reveals active choice without committing");
  key(trigger("T3 project"), "Home");
  await pause();
  key(trigger("T3 project"), "ArrowDown");
  await pause();
  key(trigger("T3 project"), "Enter");
  await pause();
  assert(trigger("T3 project").textContent.trim() === "Project 2" && changes.length === 3, "keyboard navigation commits exactly once");
  await openPicker("T3 project");
  dialog.querySelector("h2").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await pause();
  assert(!popup(), "outside pointer closes popup");
  await openPicker("T3 project");
  dialog.querySelector(".dialog-actions button").click();
  await pause();
  assert(!document.querySelector(":popover-open"), "Cancel removes top-layer popup");

  const outside = await openPicker("Outside");
  geometry(outside, trigger("Outside"));
  key(trigger("Outside"), "Home");
  await pause();
  key(trigger("Outside"), "Enter");
  await pause();
  assert(trigger("Outside").textContent.trim() === "Project 1", "outside-dialog Select retains selection behavior");

  // Place an outside-dialog trigger near the bottom, then move and resize it.
  const wrapper = trigger("Outside").parentElement;
  wrapper.style.cssText = "position:fixed;left:16px;bottom:8px;width:220px";
  const bottom = await openPicker("Outside");
  geometry(bottom, trigger("Outside"));
  assert(bottom.getBoundingClientRect().bottom < trigger("Outside").getBoundingClientRect().top, "bottom trigger opens upward");
  wrapper.style.bottom = "40px";
  window.dispatchEvent(new Event("scroll"));
  await pause();
  geometry(bottom, trigger("Outside"));
  wrapper.style.width = "180px";
  window.dispatchEvent(new Event("resize"));
  await pause();
  geometry(bottom, trigger("Outside"));
  assert(Math.abs(bottom.getBoundingClientRect().width - 180) <= 1, "resize updates popup width");
  render(null, root);
  await pause();
  assert(!document.querySelector(":popover-open"), "unmount removes top-layer popup");
  await reset();
  await openDialog();
  await openPicker("T3 project");
  root.querySelector("dialog").close();
  await pause();
  assert(!document.querySelector(":popover-open"), "native dialog close removes popup");
  return { passed: true, viewport: [innerWidth, innerHeight], changes };
}

// The actual Projects view validates catalog exclusion and Add project's local config semantics.
async function projects() {
  render(null, root);
  await pause();
  applyState({ config: { kaneo: { url: "https://tracker.example", workspaceId: "fixture" }, projects: [{ name: "Existing", t3Id: "taken-t3", kaneoId: "taken-kaneo", readyStatuses: [], doneStatuses: [], priorityLabels: [] }], discovery: {} }, status: { jobs: [] } }, true);
  sources.value = {
    t3: [{ id: "taken-t3", title: "Existing", workspaceRoot: "/example/existing" }, ...choices.map(([id, title]) => ({ id, title, workspaceRoot: `/example/${id}` }))],
    kaneo: { projects: [{ id: "taken-kaneo", name: "Existing", slug: "OLD" }, ...choices.map(([id, name]) => ({ id: `k-${id}`, name, slug: id.toUpperCase() }))], columns: {}, labels: [] },
  };
  render(html`<${Projects} />`, root);
  await pause();
  root.querySelector('button[aria-label="Add project"]').click();
  await pause();
}

async function runProjects() {
  await projects();
  const dialog = root.querySelector("dialog");
  for (const label of ["T3 project", "Kaneo project"]) {
    const before = dialog.scrollHeight;
    const button = [...dialog.querySelectorAll(".select > button")].find((b) => b.getAttribute("aria-label").startsWith(`${label}:`));
    button.click();
    await pause();
    const list = popup();
    assert(list.children.length === 51 && !list.textContent.includes("Existing"), "already configured project stays excluded");
    assert(dialog.scrollHeight === before, "real Add project stays compact");
    geometry(list, button, dialog);
    list.scrollTop = list.scrollHeight;
    list.lastElementChild.click();
    await pause();
    assert(button.textContent.includes("Project 50"), "real picker retains final choice");
  }
  dialog.querySelector(".btn-primary").click();
  await pause();
  assert(config.value.projects.length === 2, "Add project appends exactly once");
  const added = config.value.projects[1];
  assert(added.t3Id === "p50" && added.kaneoId === "k-p50" && added.repoPath === "/example/p50", "Add project keeps both selected catalog values");
  return { passed: true, viewport: [innerWidth, innerHeight], added };
}

// No requests or live credentials are used by this fixture.
actions.ensureSources = () => {};
window.selectTests = { run, reset, projects, runProjects, openDialog, openPicker };
await reset();
