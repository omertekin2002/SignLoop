# SignLoop Web

The repository's Next.js 16 App Router application. It serves both the UI and API routes on port 3000; there is no separate backend service.

See the [root README](../../README.md) for environment setup, current product behavior, provider configuration, database operations, and deployment. Follow [AGENTS.md](../../AGENTS.md) for contributor commands and persistence invariants. Use Bun for dependency operations and scripts; Node.js 22+ is also required.

## Workspace commands

Run from `apps/web` after configuring `.env.local` from [.env.local.example](.env.local.example):

```bash
bun run dev
bun run test
bun run lint
bun run check-types
bun run build
```

The production server is `bun run start` after a successful build. Build and type checking both generate `.next` files, so run them sequentially. After a build, `bun run check:ocr-trace` verifies that the image-upload routes trace everything OCR loads at runtime, and `bun run test:e2e` runs the Playwright smoke suite in `e2e/` against it in headless Chromium (install the browser once with `bunx playwright install chromium`). The suite supplies placeholder configuration itself and needs no `.env.local`.

`bun run test lib/contract-tools.test.ts` focuses a test run. Vitest runs `lib/` and `evals/` tests in Node, and component tests (`components/**/*.test.tsx`) in jsdom with Testing Library, for example `bun run test components/upload-dialog.test.tsx`; `vitest.setup.ts` loads the DOM matchers. Chat engine tests live in `packages/chat-engine`. Database tests skip without `SIGNLOOP_TEST_DATABASE_URL`; use `bun run test:integration` to create and remove a disposable local PostgreSQL database. See the root README for the `POSTGRES_BIN` override.

`bun run db:migrate` and `bun run storage:cleanup` modify the configured database/storage. They are operational commands, not tests. The root README explains environment loading and cleanup limitations.

## Source map

- `app/`: pages, layouts, and API Route Handlers.
- `components/`: dashboard, chat, upload, privacy, and shared UI.
- `lib/`: SQL, extraction, analysis, SignLoop's chat-engine binding (provider chain, contract tools, environment config), client helpers, and tests. The agent loop itself is in `packages/chat-engine`.
- `db/`: ordered migrations, migration runner, cleanup command, and integration-test setup.
- `evals/`: deterministic contract analysis evaluations replayed through the production pipeline ([README](evals/README.md)).
- `scripts/`: post-build checks (OCR build traces).
- `proxy.ts`: Clerk route protection.
- `instrumentation.ts`: optional AI SDK chat telemetry.

The `@/` import alias points to this workspace directory.
