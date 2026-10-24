// Builds the gateway as one Vercel Function using the Build Output API (.vercel/output).
// Run with Bun from apps/gateway: `bun run build:vercel`.
//
// Vercel's zero-config Node.js builder cannot run this code: it compiles each TypeScript file
// separately, so Node rejects the extensionless relative imports, and @repo/chat-engine's
// package exports still point at its `.ts` sources. Bundling the entry with Bun (target Node)
// produces a single ES module that Node runs as is.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { VERCEL_MAX_DURATION_SECONDS } from "../src/vercel-handler";

/** Node.js version of the deployed function (Vercel runtime identifier). */
const VERCEL_NODE_RUNTIME = "nodejs24.x";

const gatewayRoot = resolve(import.meta.dir, "..");
const outputDirectory = join(gatewayRoot, ".vercel", "output");
const functionDirectory = join(outputDirectory, "functions", "index.func");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(functionDirectory, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(gatewayRoot, "src", "vercel.ts")],
  outdir: functionDirectory,
  naming: "index.mjs",
  target: "node",
  format: "esm",
  packages: "bundle",
  sourcemap: "linked",
  minify: false,
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
const unexpectedOutputs = result.outputs.filter(
  (output) => !/index\.mjs(\.map)?$/.test(output.path),
);
if (unexpectedOutputs.length) {
  console.error(
    "Unexpected extra bundle outputs:",
    unexpectedOutputs.map((output) => output.path),
  );
  process.exit(1);
}

// The AI SDK's URL downloader loads undici lazily with a runtime require() that bundling cannot
// see. Ship the installed (lockfile-pinned) copy beside the bundle so that require resolves.
const undiciDirectory = dirname(
  Bun.resolveSync("undici/package.json", join(gatewayRoot, "src")),
);
await cp(undiciDirectory, join(functionDirectory, "node_modules", "undici"), {
  recursive: true,
  dereference: true,
});

const writeJson = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

// Function configuration: https://vercel.com/docs/build-output-api/primitives
await writeJson(join(functionDirectory, ".vc-config.json"), {
  runtime: VERCEL_NODE_RUNTIME,
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  shouldAddSourcemapSupport: true,
  supportsResponseStreaming: true,
  // Client disconnects fire request.signal, which aborts the chat turn.
  supportsCancellation: true,
  maxDuration: VERCEL_MAX_DURATION_SECONDS,
});

// Every path goes to the one function; its handler routes and returns 404s itself.
await writeJson(join(outputDirectory, "config.json"), {
  version: 3,
  routes: [{ src: "^/(.*)$", dest: "/index" }],
});

const bundleBytes = result.outputs
  .filter((output) => output.path.endsWith(".mjs"))
  .reduce((total, output) => total + output.size, 0);
console.log(
  `Built ${VERCEL_NODE_RUNTIME} function (${(bundleBytes / 1024).toFixed(0)} KiB, ` +
    `maxDuration ${VERCEL_MAX_DURATION_SECONDS}s) in .vercel/output`,
);
