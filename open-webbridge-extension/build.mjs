// build.mjs — produce a packaged build of the extension.
//
// Two modes:
//   --mode release  (default)  esbuild bundle + minify, THEN javascript-obfuscator
//                              (string-array + identifier mangling). For
//                              self-hosted distribution / the GitHub release zip.
//   --mode store               esbuild bundle + minify ONLY. The Chrome Web Store
//                              policy forbids obfuscation (minification is fine),
//                              so the store package must use this mode.
//
// Either way the bundle is functionally identical to the source in this repo,
// which stays open for auditing.
//
// Usage: node build.mjs [--mode release|store] [--out <dir>]
import { build } from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync,
} from "fs";
import { dirname, join, isAbsolute } from "path";
import { fileURLToPath } from "url";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const mode = arg("mode", "release");
if (mode !== "release" && mode !== "store") {
  console.error(`unknown --mode ${mode} (use release|store)`);
  process.exit(2);
}
const root = dirname(fileURLToPath(import.meta.url));
const outArg = arg("out", "dist");
const dist = isAbsolute(outArg) ? outArg : join(root, outArg);
const p = (...x) => join(root, ...x);
const d = (...x) => join(dist, ...x);

rmSync(dist, { recursive: true, force: true });
mkdirSync(d("icon"), { recursive: true });

// 1) Bundle + minify the two entry points into self-contained files.
await build({
  absWorkingDir: root,
  entryPoints: { background: "src/background.js", popup: "popup.js" },
  bundle: true,
  format: "esm",
  target: "chrome110",
  minify: true,
  legalComments: "none",
  outdir: dist,
});

// 1b) The in-page annotator is injected as a plain file by chrome.scripting, so
//     it is built as a standalone IIFE (not an ES module) and keeps the same
//     name at the package root as it has in the source tree — the injection
//     path must be identical whether the extension is loaded unpacked from the
//     repo or from dist/.
await build({
  absWorkingDir: root,
  entryPoints: { annotator: "annotator.js" },
  bundle: true,
  format: "iife",
  target: "chrome110",
  minify: true,
  legalComments: "none",
  outdir: dist,
});

// 2) Obfuscate the bundled output. Conservative options: string-array + name
//    mangling, but no control-flow flattening / dead-code injection so runtime
//    behavior and performance are unaffected.
const OBF = {
  compact: true,
  target: "browser",
  identifierNamesGenerator: "mangled",
  renameGlobals: false,
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: ["base64"],
  splitStrings: true,
  splitStringsChunkLength: 12,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  numbersToExpressions: false,
  simplify: true,
};

if (mode === "release") {
  for (const file of ["background.js", "popup.js", "annotator.js"]) {
    const src = readFileSync(d(file), "utf8");
    const out = JavaScriptObfuscator.obfuscate(src, OBF).getObfuscatedCode();
    writeFileSync(d(file), out);
  }
}

// 3) Static assets.
copyFileSync(p("popup.html"), d("popup.html"));
copyFileSync(p("popup.css"), d("popup.css"));
for (const f of readdirSync(p("icon"))) {
  if (f.endsWith(".png")) copyFileSync(p("icon", f), d("icon", f));
}

// 4) Manifest with paths rewritten to the bundled files.
const manifest = JSON.parse(readFileSync(p("manifest.json"), "utf8"));
manifest.background.service_worker = "background.js";
writeFileSync(d("manifest.json"), JSON.stringify(manifest));

console.log(`built ${outArg}/ (mode=${mode}: bundled, minified${mode === "release" ? ", obfuscated" : ""})`);
