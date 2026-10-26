// Run after `next build` (`bun run check:ocr-trace`). Vercel deploys each route with exactly the
// files in its .nft.json trace. Image OCR loads tesseract.js's worker thread, its WebAssembly core
// and the English model at runtime with Node's require and fs, so a file missing from the trace
// only fails once an image is uploaded. This check fails the build instead. Parsing runs in the
// parse-only function, so it also fails when the upload routes that call it trace any of those
// files, which would mean they bundle the parsers again. And it rejects build-machine paths
// (Turbopack's /ROOT/ prefix) in server output, which is how the OCR worker location broke before
// tesseract.js was left unbundled.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGLISH_MODEL_DIRECTORY,
  ENGLISH_MODEL_FILE,
  OCR_ROUTES,
  PARSE_CALLER_ROUTES,
  TESSERACT_CORE_BUILDS,
} from "../lib/ocr-assets.js";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(appDir, ".next", "server");
const appRequire = createRequire(path.join(appDir, "package.json"));
const failures = [];

function realPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// What OCR loads, resolved from the installed packages the way Node resolves it at runtime: the
// request-side entry points and the worker script with their static require() graphs, the core
// builds the worker can choose, and the English model.
function requiredOcrFiles() {
  const { workerPath } = appRequire(
    "tesseract.js/src/worker/node/defaultOptions.js",
  );
  const { langPath } = appRequire("@tesseract.js-data/eng");
  const files = new Set();
  const pending = [
    appRequire.resolve("tesseract.js"),
    appRequire.resolve("tesseract.js/src/worker/node/defaultOptions.js"),
    appRequire.resolve("@tesseract.js-data/eng"),
    workerPath,
  ];
  while (pending.length > 0) {
    const file = realPath(pending.pop());
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.c?js$/.test(file)) continue;
    const requireFromFile = createRequire(file);
    const source = readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(
      /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    )) {
      // The worker chooses its core build at runtime; the expected builds are added below.
      if (isBuiltin(specifier) || specifier.startsWith("tesseract.js-core/")) {
        continue;
      }
      try {
        pending.push(requireFromFile.resolve(specifier));
      } catch {
        // An optional dependency that is not installed here is not deployed either.
      }
    }
  }
  const requireFromWorker = createRequire(workerPath);
  for (const build of TESSERACT_CORE_BUILDS) {
    const script = requireFromWorker.resolve(`tesseract.js-core/${build}.js`);
    files.add(realPath(script));
    files.add(realPath(script.replace(/\.js$/, ".wasm")));
  }
  files.add(
    realPath(
      path.join(
        path.dirname(langPath),
        ENGLISH_MODEL_DIRECTORY,
        ENGLISH_MODEL_FILE,
      ),
    ),
  );
  return files;
}

function readTrace(route) {
  const traceFile = path.join(serverDir, "app", route, "route.js.nft.json");
  let trace;
  try {
    trace = JSON.parse(readFileSync(traceFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read ${path.relative(appDir, traceFile)}; run the build first.`,
      { cause: error },
    );
  }
  const traceDir = path.dirname(traceFile);
  return new Set(
    trace.files.map((file) => realPath(path.join(traceDir, file))),
  );
}

const required = requiredOcrFiles();
for (const route of OCR_ROUTES) {
  const traced = readTrace(route);
  const missing = [...required].filter((file) => !traced.has(file));
  for (const file of missing) {
    failures.push(`${route} does not trace ${path.relative(appDir, file)}`);
  }
  const ocrBytes = [...required]
    .filter((file) => traced.has(file))
    .reduce((total, file) => total + statSync(file).size, 0);
  console.log(
    `${route}: ${required.size - missing.length}/${required.size} OCR runtime files traced (${(ocrBytes / 1e6).toFixed(1)} MB)`,
  );
}

for (const route of PARSE_CALLER_ROUTES) {
  const traced = readTrace(route);
  const shipped = [...required].filter((file) => traced.has(file));
  for (const file of shipped) {
    failures.push(
      `${route} traces ${path.relative(appDir, file)}; it should leave parsing to ${OCR_ROUTES.join(", ")}`,
    );
  }
  console.log(
    `${route}: ${shipped.length}/${required.size} OCR runtime files traced (expected none)`,
  );
}

// Known harmless build paths: Next.js's precompiled dependencies record an asset base they never
// read, and ws probes for an optional native addon inside a try/catch that falls back to
// JavaScript. Anything else under /ROOT/node_modules is a build-machine path in runtime code.
const harmlessBuildPaths = [
  /\.ab="\/ROOT\/node_modules\/(?:\.bun\/[^/"]+\/node_modules\/)?next\/dist\/compiled\//,
  /\("\/ROOT\/node_modules\/(?:\.bun\/[^/"]+\/node_modules\/)?(?:bufferutil|utf-8-validate)"\)/,
];
function* serverChunks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* serverChunks(entryPath);
    else if (entry.name.endsWith(".js")) yield entryPath;
  }
}
let harmless = 0;
for (const chunk of serverChunks(serverDir)) {
  const source = readFileSync(chunk, "utf8");
  for (const match of source.matchAll(/\/ROOT\/node_modules\//g)) {
    const context = source.slice(
      Math.max(0, match.index - 30),
      match.index + 160,
    );
    if (harmlessBuildPaths.some((pattern) => pattern.test(context))) {
      harmless += 1;
      continue;
    }
    failures.push(
      `${path.relative(appDir, chunk)} contains a build-machine path: …${context.split('"').slice(0, 3).join('"')}…`,
    );
  }
}
console.log(
  `Server output: ${harmless} known harmless /ROOT/node_modules references.`,
);

if (failures.length > 0) {
  console.error(`\nOCR build check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("OCR build check passed.");
