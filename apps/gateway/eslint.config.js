import { config } from "@repo/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  // Vercel Build Output API bundle written by `bun run build:vercel`.
  { ignores: [".vercel/**"] },
  ...config,
];
