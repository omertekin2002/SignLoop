# AGENTS

## Package Manager

This project uses **bun** (not npm/yarn/pnpm). Always use `bun` for installing dependencies and running scripts.

- Install deps: `bun install`
- Add a dep: `bun add <package>` (use `-d` for dev deps)
- Run scripts: `bun run <script>`
- Execute binaries: `bunx <command>` (not `npx`)

The `packageManager` field in root `package.json` is set to `bun@1.3.11`.

## Build and Validation

- Build: `bun run build` from repo root to validate all workspaces compile.
- Dev server: `bun run dev` from repo root (web on :3000).
- Lint: `bun run lint` from repo root to run workspace linting.
- Type check: `bun run check-types` from repo root to verify TypeScript types.
- Tests: `bun run test` from `apps/web` to run vitest.
- DB migrations: `bun run db:migrate` from repo root.

## Project Structure

Turborepo monorepo with npm-style workspaces (`apps/*`, `packages/*`):

- `apps/web` - Main Next.js 16 app (port 3000)
- `packages/eslint-config` - Shared ESLint config
- `packages/typescript-config` - Shared TypeScript configs

## TypeScript Notes

- Next.js apps use `declaration: false` and `declarationMap: false` in `packages/typescript-config/nextjs.json` to avoid TS2742 errors caused by bun's symlinked node_modules layout.
- Do not re-enable `declaration` for Next.js apps unless you also address bun's module resolution paths.

## Deployment

- Deployed on Vercel. Config lives in root `vercel.json`.
- Build command: `bunx turbo build --filter=web`
- Vercel uses `bun install --frozen-lockfile --linker hoisted` from `vercel.json`.
- Keep the hoisted linker for this repository-root deployment: Vercel must resolve Next.js from root `node_modules` before running the filtered web build. Bun's default isolated workspace layout does not expose it there.
