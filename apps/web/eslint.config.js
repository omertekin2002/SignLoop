import { nextJsConfig } from "@repo/eslint-config/next-js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...nextJsConfig,
  {
    files: ["db/**/*.js"],
    languageOptions: { globals: { process: "readonly" } },
  },
];
