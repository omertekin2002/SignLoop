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

The production server is `bun run start` after a successful build. Build and type checking both generate `.next` files, so run them sequentially.

`bun run test lib/chat-tools.test.ts` focuses a test run. Database tests skip without `SIGNLOOP_TEST_DATABASE_URL`; use `bun run test:integration` to create and remove a disposable local PostgreSQL database. See the root README for the `POSTGRES_BIN` override.

`bun run db:migrate` and `bun run storage:cleanup` modify the configured database/storage. They are operational commands, not tests. The root README explains environment loading and cleanup limitations.

## Source map

- `app/`: pages, layouts, and API Route Handlers.
- `components/`: dashboard, chat, upload, privacy, and shared UI.
- `lib/`: SQL, extraction, analysis, chat tools/providers, client helpers, and tests.
- `db/`: ordered migrations, migration runner, cleanup command, and integration-test setup.
- `proxy.ts`: Clerk route protection.
- `instrumentation.ts`: optional AI SDK chat telemetry.

The `@/` import alias points to this workspace directory.
