# SignLoop Web

## Getting Started

Run the web app from the repository root:

```bash
bun run dev
```

Or run only this workspace from `apps/web`:

```bash
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Validation

From `apps/web`:

```bash
bun run test
bun run lint
bun run check-types
```

From the repository root:

```bash
bun run build
```

## Notes

This workspace uses Next.js 16, Clerk, Vercel Postgres, Vercel Blob with a local filesystem fallback, and an OpenAI-compatible LLM router.

Use Bun for all package scripts and dependency operations.
