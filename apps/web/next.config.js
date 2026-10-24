import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGLISH_MODEL_DIRECTORY,
  ENGLISH_MODEL_FILE,
  OCR_ROUTES,
  TESSERACT_CORE_BUILDS,
} from "./lib/ocr-assets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bun's hoisted linker (CI and Vercel) installs packages at the repository root; its default
// isolated linker keeps each one under node_modules/.bun/<name>@<version>/node_modules/<name>.
const installed = (name, files) =>
  files.flatMap((file) => [
    `../../node_modules/${name}/${file}`,
    `../../node_modules/.bun/${name.replace("/", "+")}@*/node_modules/${name}/${file}`,
  ]);

// Image OCR runs tesseract.js in a worker thread. Tracing follows the request side of the
// package but treats the worker script as a single file, so the worker's own modules (Node side
// only), the core builds it can require and the English model it reads from disk are listed here.
// Turbopack matches these patterns as path prefixes, so each <build>.wasm also brings the unused
// browser bundle <build>.wasm.js, and exclusions do not apply to included files.
// scripts/check-ocr-trace.mjs verifies the result after a build.
const ocrFiles = [
  ...installed("tesseract.js", [
    "package.json",
    "src/constants/*.js",
    "src/utils/*.js",
    "src/worker-script/*.js",
    "src/worker-script/{constants,node,utils}/*.js",
  ]),
  ...installed("tesseract.js-core", [
    "package.json",
    ...TESSERACT_CORE_BUILDS.flatMap((build) => [
      `${build}.js`,
      `${build}.wasm`,
    ]),
  ]),
  ...installed("wasm-feature-detect", ["package.json", "dist/cjs/index.cjs"]),
  ...installed("bmp-js", ["package.json", "index.js", "lib/*.js"]),
  ...installed("@tesseract.js-data/eng", [
    `${ENGLISH_MODEL_DIRECTORY}/${ENGLISH_MODEL_FILE}`,
  ]),
];
// Route keys are globs matched against the entry name: escape the dynamic-segment brackets, and
// keep the /route suffix so a key does not also match nested routes such as .../context/[docId].
const ocrRouteKeys = OCR_ROUTES.map(
  (route) => `${route.replace(/[[\]]/g, "\\$&")}/route`,
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: ["@repo/chat-engine"],
  // Loaded with Node's require at runtime, so the paths these packages derive from __dirname are
  // the deployed ones. Bundling them baked build-machine paths into the OCR worker location.
  serverExternalPackages: [
    "tesseract.js",
    "tesseract.js-core",
    "@tesseract.js-data/eng",
  ],
  outputFileTracingIncludes: {
    "/api/**/*": ["./db/migrations/*.sql"],
    "/callback": ["./db/migrations/*.sql"],
    ...Object.fromEntries(ocrRouteKeys.map((key) => [key, ocrFiles])),
  },
  outputFileTracingExcludes: {
    // Tracing follows the language package's entry point to its larger legacy-engine model,
    // which the LSTM engine never reads.
    "/api/**/*": ["../../node_modules/**/@tesseract.js-data/eng/4.0.0/**"],
  },
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
