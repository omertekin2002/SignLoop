# SignLoop Docs

## Getting Started

Run the docs app from the repository root:

```bash
bun run dev
```

The docs app runs on [http://localhost:3001](http://localhost:3001).

Or run only this workspace from `apps/docs`:

```bash
bun run dev
```

## Validation

From `apps/docs`:

```bash
bun run lint
bun run check-types
```

From the repository root:

```bash
bun run build
```

## Notes

Use Bun for all package scripts and dependency operations.
