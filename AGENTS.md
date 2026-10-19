# AGENTS

## Toolchain and Package Manager

- Use **Bun** for dependency operations and scripts; do not use npm, yarn, pnpm, or npx.
- Root `package.json` pins `bun@1.3.11` and requires **Node.js 22.11+**. Some scripts invoke Node directly.
- Install dependencies from the repository root: `bun install`.
- Add app dependencies from `apps/web`: `bun add <package>` (or `bun add -d <package>`).
- Run scripts with `bun run <script>` and package binaries with `bunx <command>`.

## Commands and Validation

From the repository root:

| Command               | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| `bun run dev`         | Starts the Next.js web app on port 3000 through Turbo.                                |
| `bun run build`       | Runs workspace build tasks; currently the web app is the only buildable workspace.    |
| `bun run lint`        | Runs workspace linting; the web script rejects warnings.                              |
| `bun run check-types` | Generates Next.js route types and checks TypeScript.                                  |
| `bun run test`        | Runs workspace Vitest tests through Turbo.                                            |
| `bun run db:migrate`  | Applies migrations to the configured database; this is not a validation-only command. |

From `apps/web`:

- `bun run test` runs Vitest directly. Pass a file to focus a run, e.g. `bun run test lib/chat-tools.test.ts`.
- `bun run test:integration` creates a disposable local PostgreSQL database, applies migrations, runs database regressions, and removes it. Set `POSTGRES_BIN` if PostgreSQL binaries are not in `/opt/homebrew/opt/postgresql@16/bin`.
- Database integration tests skip in ordinary test runs unless `SIGNLOOP_TEST_DATABASE_URL` is set. The disposable-database script sets this itself, or uses an already-set URL for an empty `localhost` `signloop_test` database (as CI does), and does not use `POSTGRES_URL`.
- `bun run storage:cleanup` processes the real storage-deletion outbox using configured database/storage credentials.
- `bun run check:ocr-trace` runs after a build and verifies that the OCR upload routes trace tesseract.js's worker modules, WebAssembly core builds, and English model, and that server output contains no unexpected build-machine (`/ROOT/node_modules`) paths. CI runs it after the build.

For application changes, run appropriate tests and the root build, lint, and type checks. Turbo can reuse cached results; use `bun run build --force` when a fresh build is needed. Run build and `check-types` sequentially because both generate `.next` files. Documentation-only edits need command/link/configuration checks rather than an application rebuild.

GitHub Actions (`.github/workflows/ci.yml`) runs lint, `check-types`, tests, and the build without secrets, plus `bun run test:integration` against a `postgres:16` service container, on pull requests and pushes to `main`.

## Repository Map

This is a Turborepo with workspaces in `apps/*` and `packages/*`:

- `apps/web/app`: Next.js 16 App Router pages and API Route Handlers.
- `apps/web/components`: dashboard, chat, upload, privacy, and shared UI components.
- `apps/web/lib`: analysis/chat orchestration, extraction, provider clients, SQL operations, and shared helpers.
- `apps/web/db`: migration runner, ordered SQL migrations, cleanup command, and integration-test setup.
- `packages/eslint-config`: shared ESLint presets.
- `packages/typescript-config`: shared TypeScript configurations.

`@/` resolves to `apps/web`. Tests live alongside libraries as `lib/**/*.test.ts`. See the root README for setup and current behavior; package manifests and implementation files are the source of truth for commands and limits.

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

The shared Next.js config disables `declaration` and `declarationMap` and uses `noEmit`. Keep those settings: declaration generation previously caused TS2742 errors with Bun's symlinked dependencies.

## Deployment

The repository is configured for Vercel in root `vercel.json`:

- Install: `bun install --frozen-lockfile --linker hoisted`.
- Build: `bunx turbo build --filter=web`.
- Output: `apps/web/.next`.

Keep the hoisted linker for repository-root deployment so Vercel can resolve Next.js from root `node_modules`. The build does not run migrations. SQL migration files are included in API deployment traces through `apps/web/next.config.js`. The same file keeps tesseract.js unbundled and lists the OCR runtime files for the upload routes; the shared facts live in `apps/web/lib/ocr-assets.js`. Update them together when changing OCR packages or routes. Vercel Cron runs the storage-deletion outbox cleanup daily at 03:00 UTC through an authenticated route. Set `CRON_SECRET` in the production environment.
