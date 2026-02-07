# SignLoop

SignLoop is a contract analysis web app built in a Turborepo monorepo.
It lets users upload contracts, extract text from files, run AI analysis, and review structured risk findings.

## What the app does

- Authenticated user workspace with Clerk.
- Contract upload (PDF/images/text) with text extraction.
- AI analysis via OpenAI-compatible endpoints (primary ngrok `gemini-3-flash`, fallback OpenRouter).
- Structured results: risk badge, key findings, red flags, key dates, cancellation terms, and suggested next actions.
- Project workflow for organizing contracts and related context documents.
- Persistent storage using Vercel Postgres + Vercel Blob (with local filesystem fallback for dev).

## Core workflows

### 1) Standalone contract workflow

1. User creates a contract from Dashboard.
2. User uploads a file to `/api/contracts/:id/upload`.
3. Backend stores the file in object storage and extracts text.
4. Extracted text is saved to the `contracts` table.
5. User starts analysis from the contract page.
6. Backend calls the primary ngrok model and validates/normalizes JSON output.
7. If primary fails, backend automatically falls back to OpenRouter.
8. Analysis is persisted to `analyses` and rendered in `/contracts/:id`.

### 2) Project-based workflow

1. User creates a project from Dashboard.
2. User uploads context documents to `/api/projects/:id/context`.
3. User uploads one or more contracts linked to that project.
4. User opens a contract and runs analysis.
5. Project page provides organization for contracts + context docs.

Note: context documents are currently stored/indexed and shown in the UI, but the analysis prompt currently runs on the contract text itself.

### 3) Delete/cleanup workflow

- Deleting a contract removes its analyses and uploaded file references.
- Deleting a project cascades contract/context cleanup for that project.
- Object storage deletes are attempted for collected storage keys.

## Tech stack

### Frontend

- Next.js `16` (App Router)
- React `19`
- TypeScript
- Tailwind CSS
- Radix UI + shadcn-style component patterns
- TanStack Query
- Sonner toasts

### Backend (inside Next.js route handlers)

- Clerk auth (`@clerk/nextjs`)
- Vercel Postgres (`@vercel/postgres`)
- Vercel Blob (`@vercel/blob`)
- OpenAI SDK talking to OpenAI-compatible providers
- Zod schemas for analysis validation

### Document processing

- `unpdf` for PDF text extraction
- `tesseract.js` OCR fallback for images/scanned content

### Monorepo/tooling

- Turborepo
- ESLint + TypeScript checks
- Vitest (targeted regression tests)

## Repository structure

- `apps/web`: main SignLoop product app
- `apps/docs`: secondary Next.js app (template/docs playground)
- `packages/ui`: shared UI package
- `packages/eslint-config`, `packages/typescript-config`: shared configs

## API surface (web app)

Contracts:

- `GET /api/contracts`
- `POST /api/contracts`
- `GET /api/contracts/:id`
- `DELETE /api/contracts/:id`
- `POST /api/contracts/:id/upload`
- `POST /api/contracts/:id/analyze`
- `DELETE /api/contracts/:id/analysis/:analysisId`

Projects:

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/projects/:id/context`
- `POST /api/projects/:id/context`
- `DELETE /api/projects/:id/context/:docId`

Misc:

- `POST /api/analyze` (direct text analyze endpoint)
- `GET /api/jobs/:id` (status endpoint used by current flow)

## Data model (high level)

Main tables:

- `projects`
- `contracts`
- `analyses`
- `context_documents`
- `contract_files`

Schema is created in two ways:

- Runtime `ensureSchema()` bootstrap in `apps/web/lib/server-db.ts`
- SQL migrations in `apps/web/db/migrations`

## Environment variables

Set these for `apps/web` (and in Vercel for deploys):

Required for auth:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`

Primary analysis provider (OpenAI-compatible endpoint):

- `PRIMARY_LLM_BASE_URL` (defaults to `https://efficient-sightlessly-ouida.ngrok-free.dev/v1`)
- `PRIMARY_LLM_MODEL` (default `gemini-3-flash`)
- `PRIMARY_LLM_API_KEY` (optional; only needed if your endpoint requires auth)

Fallback analysis provider (OpenRouter):

- `OPENROUTER_API_KEY` (required for fallback)
- `OPENROUTER_MODEL` (default `openrouter/free`)
- `OPENROUTER_BASE_URL` (defaults to OpenRouter URL)
- `NEXT_PUBLIC_APP_URL` (used as referer header)

Required for database (`@vercel/postgres`):

- `POSTGRES_URL`
- `POSTGRES_URL_NON_POOLING`

Object storage:

- `BLOB_READ_WRITE_TOKEN` (enables Vercel Blob)

Local storage fallback (dev only if Blob token is missing):

- `LOCAL_STORAGE_PATH` (optional)
- `LOCAL_STORAGE_BUCKET` (optional)

## Local development

From repo root:

```bash
npm install
npm run dev
```

Web app default dev port: `3000`
Docs app default dev port: `3001`

## Validation commands

From repo root:

```bash
npm run build
npm run lint
npm run check-types
```

Web-only tests:

```bash
npm --workspace apps/web run test
```

## Deployment notes (Vercel)

- Provision/connect Vercel Postgres and Vercel Blob.
- Ensure env vars above exist in Development/Preview/Production.
- Redeploy after env changes.

## Current focus/known behavior

- Analysis pipeline is hardened against malformed model output:
  - strict + lenient schema validation,
  - normalization/coercion for common LLM formatting issues,
  - JSON repair retry path.
- Analysis defaults to ngrok `gemini-3-flash`, with automatic fallback to OpenRouter if the primary endpoint fails.
- Contract/project flows are database-backed (no in-memory mock data).
