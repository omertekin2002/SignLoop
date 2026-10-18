import { nextJsConfig } from "@repo/eslint-config/next-js";

// `bun run` loads apps/web/.env.local, so evaluation code could reach real infrastructure. The
// suite only replays fixtures through pure analysis code; it must never touch the database or
// object storage, including through a dynamic import().
const evalBoundaryMessage =
  "Evaluation code must not reach the database or object storage; replay fixtures through pure analysis code instead.";
const evalForbiddenModules = [
  "**/lib/server-db",
  "**/lib/object-storage",
  "**/lib/storage-cleanup",
  "**/lib/upload-pipeline",
  "@vercel/blob",
  "@vercel/postgres",
  "pg",
];

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...nextJsConfig,
  {
    files: ["db/**/*.js"],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    files: ["evals/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: evalForbiddenModules, message: evalBoundaryMessage },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // esquery regexes cannot contain "/", so "." stands in for the package scope separator.
          selector:
            "ImportExpression[source.value=/lib.(server-db|object-storage|storage-cleanup|upload-pipeline)$|^@vercel.(blob|postgres)$|^pg$/]",
          message: evalBoundaryMessage,
        },
      ],
    },
  },
];
