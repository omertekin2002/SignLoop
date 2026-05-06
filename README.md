# SignLoop

SignLoop is a Bun + Turborepo monorepo centered around an AI-assisted contract workspace.

The main app lets users:
- upload contracts and extract text from PDF, Word, plain text, and image files,
- run structured AI analysis with normalized legal-risk output,
- organize work in projects with supporting context documents,
- chat in either temporary (not persisted) or saved thread mode.

---

## What Is In This Repository

- `apps/web`: the production product (`Next.js 16`, App Router) running on `:3000`
- `apps/docs`: a secondary docs app (`Next.js 16`) on `:3001` (currently starter scaffold)
- `packages/ui`: shared React UI package
- `packages/eslint-config`: shared ESLint presets
- `packages/typescript-config`: shared TypeScript configs

This repo uses:
- `bun` as the package manager and script runner
- `turbo` for workspace orchestration
- `@vercel/postgres` for data
- `@vercel/blob` with local filesystem fallback for object storage
- Clerk for authentication
- OpenAI-compatible providers for analysis/chat generation

---

## Core Product Flows

### 1) Contract upload and text extraction

1. Frontend creates a contract record (`POST /api/contracts`).
2. File upload endpoint receives the file (`POST /api/contracts/:id/upload`).
3. Server validates MIME type and size (20MB max).
4. Text extraction is chosen by type:
   - PDF: `unpdf` (with scanned-PDF low-density fallback marker)
   - Images: `tesseract.js` OCR
   - Word: `word-extractor`
   - TXT: direct decode
5. Binary is stored in:
   - Vercel Blob if `BLOB_READ_WRITE_TOKEN` exists, or
   - local filesystem (`apps/web/uploads` by default).
6. Extracted text is saved into `contracts.text_content`.

### 2) Contract analysis

1. Analysis runs via `POST /api/contracts/:id/analyze`.
2. `analyzeText()` builds a strict JSON-oriented prompt and calls the primary OpenAI-compatible endpoint.
3. If primary fails, it falls back to OpenRouter models.
4. Output is parsed, repaired (if malformed), normalized, and validated against Zod schemas.
5. Result is stored in `analyses.result_json`, and contract status moves to `ANALYZED`.

### 3) Project-aware contract work

- Projects are created under the authenticated user.
- Contracts can be linked to a project.
- Context documents are uploaded to projects (`/api/projects/:id/context`), extracted when possible, and persisted with metadata (type, word count, storage key).
- Project detail pages combine contract analyses + context inventory for legal-review workflows.

### 4) Chat (temporary + persisted threads)

- Temporary chat works without login and is not saved.
- Saved chat requires auth and persists:
  - `chat_threads`
  - `chat_messages` (ordered by transactional position locking)
- Chat uses a configurable persona (`signloop-assistant` or `bare-llm`).
- For supported models (`gpt-5` family), native web search tools can be used and source links are appended to replies.

---

## API Surface (Web App)

Main route groups in `apps/web/app/api`:

- `contracts`
  - list/create contracts
  - upload files
  - run analysis
  - delete analyses/contracts
- `projects`
  - list/create/delete projects
  - upload/delete context docs
- `chat`
  - send chat completions
  - create/list/delete/get threads
- `settings`
  - read and update model/personality preferences
- `jobs`
  - lightweight status endpoint used by analysis polling UI

Most endpoints require Clerk auth; temporary chat is the main unauthenticated exception.

---

## Data Model Overview

Primary tables:

- `projects`
- `contracts` (contains extracted text and status)
- `analyses` (structured AI output + provider/model metadata)
- `context_documents`
- `contract_files` (uploaded file metadata + storage keys)
- `user_settings` (preferred primary model + personality)
- `chat_threads`
- `chat_messages`

Migrations live in `apps/web/db/migrations`, and a migration runner exists at `apps/web/db/migrate.js`.

---

## Environment Variables

Set these in `.env.local` (or your deployment environment).

Required for core authenticated app + persistence:
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `POSTGRES_URL`
- `POSTGRES_URL_NON_POOLING`

Primary LLM endpoint (OpenAI-compatible):
- `PRIMARY_LLM_BASE_URL` (default provided in code)
- `PRIMARY_LLM_MODEL` (default: `gemini-3-flash`)
- `PRIMARY_LLM_API_KEY` (optional if endpoint does not require auth)

Fallback LLM endpoint (OpenRouter):
- `OPENROUTER_API_KEY` (required for fallback)
- `OPENROUTER_BASE_URL` (default: `https://openrouter.ai/api/v1`)
- Fallback model order is fixed in code: `google/gemma-4-31b-it:free`, then `openai/gpt-oss-120b:free`, then `openrouter/free`

Storage:
- `BLOB_READ_WRITE_TOKEN` (if set, enables Vercel Blob)
- `LOCAL_STORAGE_PATH` (optional local fallback path)
- `LOCAL_STORAGE_BUCKET` (optional local fallback bucket label)

App URL metadata:
- `NEXT_PUBLIC_APP_URL` (used in LLM request headers; defaults to `http://localhost:3000`)

---

## Local Development

### Prerequisites

- Bun `1.3.11+`
- Node `18+` (engine minimum)

### Install

```bash
bun install
```

### Run all apps in dev mode

```bash
bun run dev
```

- Web: [http://localhost:3000](http://localhost:3000)
- Docs: [http://localhost:3001](http://localhost:3001)

### Run one workspace only

From `apps/web`:
```bash
bun run dev
```

From `apps/docs`:
```bash
bun run dev
```

---

## Quality and Validation Commands

From repository root:

```bash
bun run lint
bun run check-types
bun run build
```

Web tests (from `apps/web`):

```bash
bun run test
```

Run database migrations (from repo root):

```bash
bun run db:migrate
```

---

## Deployment Notes

- Root `vercel.json` builds only the web app using Turbo filters.
- `apps/web/vercel.json` contains workspace-level build settings.
- Bun is the expected package manager in CI/deploy environments.

---

## Current State of `apps/docs`

`apps/docs` is present in the monorepo and wired into Turbo scripts, but currently contains the default scaffold content rather than full product documentation pages.
