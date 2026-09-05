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
3. Server validates MIME type and size (4 MiB max, with bounded multipart overhead).
4. Text extraction is chosen by type:
   - PDF: `unpdf` (with scanned-PDF low-density fallback marker)
   - Images: `tesseract.js` OCR
   - Word: `word-extractor`
   - TXT: direct decode
5. Binary is stored in:
   - Vercel Blob if `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` exists, or
   - local filesystem (`apps/web/uploads` by default).
6. Extracted text is saved into `contracts.text_content`.

### 2) Contract analysis

1. Analysis runs via `POST /api/contracts/:id/analyze`.
2. `analyzeText()` builds a strict JSON-oriented prompt and calls the primary OpenAI-compatible endpoint.
3. Transport failures can fall back to OpenRouter. Semantic validation failures remain on the original provider and are rejected.
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
- Every authenticated chat turn performs one Google-grounded Gemini research pass before
  generation. The same bounded research brief is supplied to the selected primary model or any
  OpenRouter fallback, and source links are appended to the reply.

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
- `chat_attachments` (image bytes fetched separately through an ownership-checked route)
- `generation_operations` (expiring leases for overlapping inference)
- `storage_deletions` (durable object cleanup outbox)

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

- `PRIMARY_LLM_BASE_URL` (required to enable the primary provider; include its `/v1` prefix)
- `PRIMARY_LLM_MODEL` (default: `gemini-3-flash`)
- `PRIMARY_LLM_API_KEY` (optional if endpoint does not require auth)

SignLoop caches model discovery for 60 seconds (10 seconds after failure). Normal chat and analysis
reuse that cache. Opening the selector or explicitly refreshing settings can request fresh discovery.
Creating an empty chat does not contact a provider. When no primary model is available, inference
skips primary and uses the configured OpenRouter fallback.

Fallback LLM endpoint (OpenRouter):

- `OPENROUTER_API_KEY` (required for fallback)
- `OPENROUTER_BASE_URL` (default: `https://openrouter.ai/api/v1`)
- Fallback model order is fixed in code: `google/gemma-4-31b-it:free`, then `openai/gpt-oss-120b:free`, then `openrouter/free`

Model-independent web search:

- `GEMINI_API_KEY` (required for authenticated chat)
- `GEMINI_SEARCH_MODEL` (optional; defaults to `gemini-2.5-flash`)
- Search is always on for signed-in users, runs once per turn, and is reused across
  primary/OpenRouter retries. Anonymous temporary chat remains unsearched. If Gemini does not
  return grounded web sources, the request fails instead of silently returning an unsearched
  answer.

Storage:

- `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` (enables Vercel Blob; store-ID authentication uses Vercel OIDC)
- `BLOB_ACCESS` (defaults to `private`; existing public stores must explicitly set `public`)
- `LOCAL_STORAGE_PATH` (optional local fallback path)
- `LOCAL_STORAGE_BUCKET` (optional local fallback bucket label)

App URL metadata:

- `NEXT_PUBLIC_APP_URL` (used in LLM request headers; defaults to `http://localhost:3000`)

Schema bootstrap:

- `SKIP_SCHEMA_BOOTSTRAP` (set to `1` in deployments where `bun run db:migrate` is applied at
  deploy time; skips runtime migration checks. When unset, startup and the command run the same
  automatically discovered migrations under a database advisory lock.)

---

## Local Development

### Prerequisites

- Bun `1.3.11+`
- Node `20.9+` (engine minimum, see root `package.json`)

### Install

```bash
bun install
```

### Run dev mode

```bash
bun run dev
```

- Web: [http://localhost:3000](http://localhost:3000)

### Run one workspace only

From `apps/web`:

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
- Bun is the expected package manager in CI/deploy environments.


## Audit fixes and rollout

Apply `bun run db:migrate` before deploying with `SKIP_SCHEMA_BOOTSTRAP=1`. Migration 012 installs
foreign keys/cascades, deletion outbox triggers, context invalidation, and generation leases.
It validates existing relationships where possible; legacy orphan rows are retained and generate
warnings, rather than being silently deleted. Migrations 013–014 add chat attachments and persisted
extraction warnings. The runtime includes these migration files in its deployment trace.

Analysis has a 270-second operation deadline and chat a 155-second deadline, leaving time for
persistence within their route budgets. SDK retries are disabled; fallback streaming attempts are
bounded to 45 seconds. Contract and context changes invalidate previous analyses. The detail page
shows evidence limitations and fetches historical result bodies only when selected.

Dashboard collections load in pages of 50. Saved chats initially load the most recent 50 messages,
with older history on demand. Successful turns update the cache from the newly persisted message
pair. New saved images live in `chat_attachments`; older inline images remain readable via the same
authenticated image route. Temporary chats retain images only in browser conversation state.

Database deletion records object cleanup work atomically, including concurrent uploads committed
before the cascade. Delete requests process the outbox after responding. Failed cleanup remains
queued for subsequent delete requests or this command (from `apps/web`):

```bash
bun run storage:cleanup
```

The command processes bounded batches. It does not create a recurring job; deployments that need
cleanup retries without subsequent traffic should schedule this command in their operations setup.

Run concurrency and migration regression tests against a disposable local PostgreSQL instance:

```bash
cd apps/web
bun run test:integration
```

The script defaults to Homebrew PostgreSQL 16. Set `POSTGRES_BIN` to another installation's `bin`
directory if needed. It creates a temporary database using a Unix socket, applies every migration,
runs ownership/concurrency tests, then stops and removes that database. It never uses `POSTGRES_URL`.

Remaining architectural work: direct-to-storage uploads above 4 MiB, automatic retries for cleanup
without traffic, admission/spending quotas for anonymous inference, process isolation for document
parsers, and pagination of very large per-project collections and analysis-history metadata. These
require separate storage/product/operations choices; the current fixes preserve existing chat and
web-search policy. No production migration or deployment is performed by the test commands.
