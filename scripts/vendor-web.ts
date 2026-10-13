// Copy the browser runtime from node_modules into web/vendor with bare imports
// rewritten to relative paths, so the page needs no import map or bundler.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, ".."),
  out = join(root, "web/vendor");
const modules: Record<string, string> = {
  preact: "preact/dist/preact.module.js",
  "preact/hooks": "preact/hooks/dist/hooks.module.js",
  "@preact/signals-core": "@preact/signals-core/dist/signals-core.module.js",
  "@preact/signals": "@preact/signals/dist/signals.module.js",
  htm: "htm/dist/htm.module.js",
};
const file = (name: string) => name.replace(/^@/, "").replaceAll("/", "-") + ".js";
mkdirSync(out, { recursive: true });
for (const [name, path] of Object.entries(modules)) {
  let source = readFileSync(join(root, "node_modules", path), "utf8");
  for (const dep of Object.keys(modules))
    source = source.replaceAll(`from"${dep}"`, `from"./${file(dep)}"`);
  source = source.replace(/\n?\/\/# sourceMappingURL=.*$/m, "");
  writeFileSync(join(out, file(name)), source);
  console.log(`${file(name)} <- ${path}`);
}
