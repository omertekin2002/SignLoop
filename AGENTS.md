# AGENTS

## Toolchain and Package Manager

- Use **Bun** for dependency operations and scripts; do not use npm, yarn, pnpm, or npx.
- Root `package.json` pins `bun@1.4.4` and requires **Node.js 22.11+**. Some scripts invoke Node directly.
- Install dependencies from the repository root: `bun install`.
- Add app dependencies from `apps/web`: `bun add <package>` (or `bun add -d <package>`). Add gateway dependencies from `apps/gateway` and chat engine dependencies from `packages/chat-engine` the same way. There is one lockfile, the root `bun.lock`.
- Run scripts with `bun run <script>` and package binaries with `bunx <command>`.

## Commands and Validation

From the repository root:

| Command               | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| `bun run dev`         | Starts the Next.js web app on port 3000 through Turbo (web only).                     |
| `bun run build`       | Runs workspace build tasks; the web app is the only buildable workspace (no gateway). |
| `bun run lint`        | Runs workspace linting; every workspace's script rejects warnings.                    |
| `bun run check-types` | Checks TypeScript in every workspace; the web script first generates route types.     |
| `bun run test`        | Runs workspace Vitest tests (web, gateway, and chat engine) through Turbo.            |
| `bun run db:migrate`  | Applies migrations to the configured database; this is not a validation-only command. |

From `apps/web`:

- `bun run test` runs Vitest directly. Pass a file to focus a run, e.g. `bun run test lib/contract-tools.test.ts`.
- `bun run test:integration` creates a disposable local PostgreSQL database, applies migrations, runs database regressions, and removes it. Set `POSTGRES_BIN` if PostgreSQL binaries are not in `/opt/homebrew/opt/postgresql@16/bin`.
- Database integration tests skip in ordinary test runs unless `SIGNLOOP_TEST_DATABASE_URL` is set. The disposable-database script sets this itself, or uses an already-set URL for an empty `localhost` `signloop_test` database (as CI does), and does not use `POSTGRES_URL`.
- `bun run storage:cleanup` processes the real storage-deletion outbox using configured database/storage credentials.
- `bun run check:ocr-trace` runs after a build and verifies that the OCR upload routes trace tesseract.js's worker modules, WebAssembly core builds, and English model, and that server output contains no unexpected build-machine (`/ROOT/node_modules`) paths. CI runs it after the build.

From `packages/chat-engine`, `bun run test`, `bun run lint`, and `bun run check-types` run the engine's own Vitest suite (`src/**/*.test.ts`), ESLint, and `tsc --noEmit`.

From `apps/gateway`:

- `bun run dev` / `bun run start` run the public chat API with Bun (watch mode / production) on port 10000. Configuration comes from the environment; Bun loads `apps/gateway/.env` (start from `.env.example`).
- `bun run test`, `bun run lint`, and `bun run check-types` run its Vitest suite (`tests/**/*.test.ts`), ESLint, and `tsc --noEmit`. It has no build step: Bun runs its TypeScript directly.
- `tests/contract.test.ts` compares the public HTTP API (status codes, headers, JSON bodies, NDJSON events, log entries) with golden fixtures in `tests/fixtures/contract/`. External callers such as the otekin CLI depend on that shape. A failure means a change, often in the engine, altered the API; fix the change, or for an intentional API change review the fixture diff and rerun with `bun run test -u`.
- `RUN_LIVE_TESTS=1 bun run test tests/live.test.ts` runs the opt-in live smoke test against real providers configured in the environment.

For application changes, run appropriate tests and the root build, lint, and type checks. Turbo can reuse cached results; use `bun run build --force` when a fresh build is needed. Run build and `check-types` sequentially because both generate `.next` files. Documentation-only edits need command/link/configuration checks rather than an application rebuild.

GitHub Actions (`.github/workflows/ci.yml`) runs lint, `check-types`, tests, and the build without secrets, boots the gateway under Bun and probes `/healthz`, plus `bun run test:integration` against a `postgres:16` service container, on pull requests and pushes to `main`.

## Repository Map

This is a Turborepo with workspaces in `apps/*` and `packages/*`:

- `apps/web/app`: Next.js 16 App Router pages and API Route Handlers.
- `apps/web/components`: dashboard, chat, upload, privacy, and shared UI components.
- `apps/web/lib`: analysis, SignLoop's chat-engine binding (`chat.ts`, `chat-engine-config.ts`, `contract-tools.ts`), saved-chat policy and titles, extraction, provider clients, SQL operations, and shared helpers.
- `apps/web/db`: migration runner, ordered SQL migrations, cleanup command, and integration-test setup.
- `apps/gateway`: the public, stateless chat API (`POST /v1/chat`, `/healthz`) on Bun and Render, formerly the SLgateway repository. `src/handler.ts` (HTTP boundary, errors, CORS, request IDs, allowlisted logs), `src/config.ts`, `src/concurrency.ts`, and in `src/pipeline/` the chat policy, model discovery (`provider-models.ts`), provider chain (`agent-provider.ts`, `llm-client.ts`), and the engine binding (`chat.ts`).
- `packages/chat-engine`: `@repo/chat-engine`, the agent loop, provider routing, generic tools, replay, source catalogs, and citations, shared by `apps/web` and `apps/gateway`.
- `packages/eslint-config`: shared ESLint presets.
- `packages/typescript-config`: shared TypeScript configurations.

`@/` resolves to `apps/web`. Tests live alongside libraries as `lib/**/*.test.ts` in the web app and `src/**/*.test.ts` in the chat engine; gateway tests live in `apps/gateway/tests`. See the root README for setup and current behavior; package manifests and implementation files are the source of truth for commands and limits.

## Chat Engine

- `packages/chat-engine` ships TypeScript source; Next.js compiles it through `transpilePackages` in `apps/web/next.config.js`, and Bun runs it directly. Keep it runnable on both Node and Bun: keep the `undici/index.js` import (Bun's built-in undici lacks custom dispatchers).
- The package must not read `process.env` or import from `apps/web`, `apps/gateway`, Next.js, the database, or auth. Pass endpoints, keys, models, and per-turn switches as options. `apps/web/lib/chat-engine-config.ts` maps SignLoop's environment to that configuration; `apps/web/lib/chat.ts` keeps the API the routes use. `apps/gateway/src/pipeline/chat.ts` does the same for the gateway's validated startup configuration.
- Engine changes reach both apps. New behavior that only one app wants must be an opt-in option whose default keeps the other app unchanged (as `maxOutputTokens: null`, `onStreamError`, and `rethrowAbortReason` are for the gateway). Run the gateway's contract tests as well as the web tests after engine changes.
- Policy constants shared by every caller (step and tool budgets, catalog caps, `TEXT_REASONING_EFFORT`, the 16k output cap) live in the package.
- Provider routing is an ordered `providers` list of candidates. Application tools plug in as tool extensions (`ChatToolExtension`), as `apps/web/lib/contract-tools.ts` does for `list_contracts`/`read_contract`.
- `src/index.ts` is the public entry point. Browser code must import single modules (`@repo/chat-engine/chat-history-shared`, `@repo/chat-engine/bounded-response`) so the AI SDK stays out of client bundles; `lib/chat-history-client.test.ts` checks this.
- Engine behavior tests belong in the package; tests of SignLoop's routing, environment mapping, contract tools, and routes stay in `apps/web`, and tests of the gateway's HTTP API, configuration, discovery, and provider chain stay in `apps/gateway`.

## Design System

UI follows `DESIGN.md` at the repository root: the Dala style reference plus a "SignLoop Implementation" section that governs SignLoop code. Tokens live in `apps/web/app/globals.css` and `apps/web/tailwind.config.ts` (Tailwind v3). The app defaults to dark and has a light theme driven by semantic tokens. Use semantic or Dala token classes rather than raw palette colours, and merge classes with `cn()` so the custom type scale survives.

## Data and Configuration

- Put local web configuration in `apps/web/.env.local`; start from `apps/web/.env.local.example`.
- Runtime SQL uses `POSTGRES_URL`; the standalone migration client uses `POSTGRES_URL_NON_POOLING`. Both commands need their variables in the process environment. From the root, `bun --env-file=apps/web/.env.local run db:migrate` explicitly loads local migration credentials.
- Migrations are tracked by filename. Add a new numbered SQL file for schema changes; do not rewrite an applied migration.
- Unless `SKIP_SCHEMA_BOOTSTRAP=1`, the first database operation runs pending migrations through the shared runner. Apply migrations before enabling that flag.
- Preserve owner-scoped SQL, transactional writes, generation leases, revision checks, and deletion-outbox behavior when changing persistence paths.
- Keep secrets and generated uploads out of source control. When adding environment variables, check the example file and Turbo's environment configuration.

## TypeScript

The shared Next.js config and the `source-package` preset used by `packages/chat-engine` and `apps/gateway` disable `declaration` and `declarationMap` and use `noEmit`. Keep those settings: declaration generation previously caused TS2742 errors with Bun's symlinked dependencies.

## Deployment

`apps/web` deploys to Vercel and `apps/gateway` to Render. The repository is configured for Vercel in root `vercel.json`:

- Install: `bun install --frozen-lockfile --linker hoisted`.
- Build: `bunx turbo build --filter=web`.
- Output: `apps/web/.next`.

Keep the hoisted linker for repository-root deployment so Vercel can resolve Next.js from root `node_modules`. Vercel's Neon integration creates a database branch for each previewed git branch, and the Neon Free plan allows about 10. A full plan makes previews fail at "Provisioning Integrations" with "Branch limit reached". Deleting a preview deployment frees its branch. `.github/workflows/vercel-preview-cleanup.yml` deletes a pull request's preview deployments when it closes, and a manual run deletes previews of every branch without an open pull request. It needs the `VERCEL_PREVIEW_CLEANUP_TOKEN` secret and the `VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` repository variables. The chat engine is a workspace dependency compiled into the web build (`transpilePackages`); it needs no build step of its own. The build does not run migrations. SQL migration files are included in API deployment traces through `apps/web/next.config.js`. The same file keeps tesseract.js unbundled and lists the OCR runtime files for the upload routes; the shared facts live in `apps/web/lib/ocr-assets.js`. Update them together when changing OCR packages or routes. Vercel Cron runs the storage-deletion outbox cleanup daily at 03:00 UTC through an authenticated route. Set `CRON_SECRET` in the production environment.

The gateway is configured for Render in root `render.yaml` (service `signloop-chat-api`; Render reads Blueprints from the repository root):

- Install: `bun install --frozen-lockfile --linker hoisted --filter gateway` from the repository root, then `check-types` and `test` in `apps/gateway`.
- Start: `cd apps/gateway && bun run start`; health check `/healthz`. `BUN_VERSION` pins Bun 1.4.4.
- `buildFilter` deploys only for changes to `apps/gateway`, `packages/chat-engine`, `packages/typescript-config`, `bun.lock`, or the root `package.json`.

Do not set a `rootDir` for the gateway: Render makes files outside a service's root directory unavailable at build and run time, and the gateway needs `packages/chat-engine` and the root lockfile. Vercel's build (`--filter=web`) never builds the gateway, but its ignore command treats `packages/` and `bun.lock` changes as web changes. When adding gateway environment variables, update `apps/gateway/.env.example`, `render.yaml`, and `apps/gateway/README.md`. The cutover from the standalone SLgateway repository is described in `apps/gateway/README.md`.
