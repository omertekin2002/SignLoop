# SignLoop

SignLoop is an AI-assisted contract workspace built with Next.js 16, React, Clerk, PostgreSQL, and OpenAI-compatible model providers. Users can upload contracts, request structured analysis, organize supporting documents in projects, and use temporary or saved chat.

The Bun/Turborepo repository contains one application, `apps/web`, plus shared ESLint and TypeScript configuration packages. There is no separate API server or background inference worker: API Route Handlers perform extraction, analysis, and chat orchestration.

## Local setup

Requirements: **Node.js 22+** and **Bun 1.3.11**, the version pinned in [package.json](package.json).

From the repository root:

```bash
bun install
cp apps/web/.env.local.example apps/web/.env.local
```

Fill in the Clerk and database credentials, then configure a primary model endpoint and/or OpenRouter for inference. Optional integrations in the example are commented out; enable only those you intend to use. The environment file belongs in `apps/web`, not the repository root.

```bash
bun run dev
```

Open [localhost:3000](http://localhost:3000). Running `bun run dev` from `apps/web` starts the same app directly, without Turbo.

For an explicit local migration run, after configuring the environment file:

```bash
bun --env-file=apps/web/.env.local run db:migrate
```

This changes the configured database. The migration entry point invokes Node and does not itself load Next.js environment files; the explicit Bun flag supplies those variables. When credentials are already exported or provided by deployment tooling, `bun run db:migrate` is sufficient.

## Commands

| From repository root  | Purpose                                                 |
| --------------------- | ------------------------------------------------------- |
| `bun run dev`         | Web development server on port 3000.                    |
| `bun run build`       | Production web build through Turbo.                     |
| `bun run lint`        | Workspace linting, rejecting warnings.                  |
| `bun run check-types` | Next.js route type generation and TypeScript checking.  |
| `bun run test`        | Workspace tests through Turbo.                          |
| `bun run db:migrate`  | Apply pending migrations using the configured database. |

Turbo may return cached results. Use `bun run build --force` for a fresh build. Run build and type checking sequentially because both generate `.next` files.

From `apps/web`, `bun run test` invokes Vitest directly; a path narrows the run, for example `bun run test lib/chat-tools.test.ts`.

Database tests skip unless `SIGNLOOP_TEST_DATABASE_URL` is supplied. The supported disposable-database workflow is:

```bash
cd apps/web
bun run test:integration
```

It initializes local PostgreSQL, applies migrations, runs database ownership/concurrency tests, and removes the temporary database. It never uses `POSTGRES_URL`. The default binary directory is `/opt/homebrew/opt/postgresql@16/bin`; set `POSTGRES_BIN` for another installation. This is separate from testing against production credentials or live model services.

## Configuration

Start with [apps/web/.env.local.example](apps/web/.env.local.example). Actual behavior is defined in the linked implementation files below.

### Authentication and database

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` configure Clerk. The example also sets sign-in/sign-up routes and post-auth destinations.
- `POSTGRES_URL` is used by runtime pooled SQL operations.
- `POSTGRES_URL_NON_POOLING` is used by the standalone migration client.
- `SKIP_SCHEMA_BOOTSTRAP=1` disables runtime migration checks. Otherwise the first database operation in a process runs pending migrations using the shared runner, with initialization reused by later operations. This is lazy initialization, not a startup job.

The root page, sign-in/up pages, and `/api/chat` are public in [proxy.ts](apps/web/proxy.ts). The chat handler permits anonymous requests only in temporary mode. Other application APIs enforce authentication and owner-scoped data access.

### Model providers

- `PRIMARY_LLM_BASE_URL` enables the primary provider; include the API prefix, normally `/v1`.
- `PRIMARY_LLM_API_KEY` may be empty only if that endpoint intentionally accepts unauthenticated requests.
- `PRIMARY_LLM_MODEL` supplies the default for callers without an explicit model, including anonymous chat. Its current fallback is `gemini-3-flash`.
- `OPENROUTER_API_KEY` enables fallback inference; `OPENROUTER_BASE_URL` defaults to `https://openrouter.ai/api/v1`.
- `NEXT_PUBLIC_APP_URL` supplies app URL metadata in provider request headers, defaulting to `http://localhost:3000`.

Signed-in chat and analysis select the saved model if available, otherwise the first eligible model returned by the primary `/models` endpoint. They do not use `PRIMARY_LLM_MODEL` as the selector's default. Discovery is cached per process for 60 seconds, or 10 seconds following failure; ordinary selector/settings reads reuse this cache. Saving an unavailable primary model forces one fresh check; explicit `GET /api/settings?refreshModels=1` remains available. Anonymous chat skips discovery and uses the configured default.

If no primary model is available to an authenticated request, it uses the configured OpenRouter chain. When OpenRouter is configured, users can also pin `openrouter/free`, which skips primary inference. The current fallback order and image-model identifier live in [model-settings.ts](apps/web/lib/model-settings.ts). Image generation is offered only to signed-in users when primary discovery advertises `gpt-image-2`.

Chat endpoints must support Responses API function tools and tool-result continuation. Analysis uses Responses JSON output, with a compatibility retry when JSON mode is unsupported. Provider compatibility tests use mocks; passing them does not establish that deployed credentials or live providers work.

### Search and page reading

Search is model-selected during a chat turn; there is no mandatory pre-search on every request.

- `WEB_SEARCH_PROVIDER` can explicitly select `brave`, `firecrawl`, or `gemini`.
- Without an explicit selection, configured keys are preferred in this order: `BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`, then `GEMINI_API_KEY`.
- Gemini search uses the Gemini Developer API with Google Search grounding. `GEMINI_SEARCH_MODEL` defaults to `gemini-2.5-flash`; it is independent of the model answering the user.
- Provider selection is not a retry chain. Search failures become tool error results for the model to handle.
- `read_url` uses Firecrawl when `FIRECRAWL_API_KEY` is set, otherwise Jina Reader. A Firecrawl failure can also fall back to Jina while the shared deadline remains. `JINA_API_KEY` is optional.
- `http_get` requires no provider key. It fetches public HTTP(S) addresses directly, validating each redirect and DNS addresses at connection time; it returns bounded response bodies and status codes.

See [web-search.ts](apps/web/lib/web-search.ts), [url-reader.ts](apps/web/lib/url-reader.ts), and [http-fetch.ts](apps/web/lib/http-fetch.ts).

### Object storage

- `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` selects Vercel Blob. Store-ID authentication uses Vercel OIDC; a read-write token can be supplied locally.
- `BLOB_ACCESS` defaults to `private` and must match the store. Public stores require explicit `BLOB_ACCESS=public`.
- With neither Blob setting, local development stores files in `apps/web/uploads` when launched through the workspace scripts.
- `LOCAL_STORAGE_PATH` overrides that directory; relative paths resolve from the process working directory. In production, local storage requires this explicit setting and a persistent writable filesystem. An ordinary Vercel function filesystem is not a durable local-storage setup.
- `LOCAL_STORAGE_BUCKET` is a stored metadata label, defaulting to `local-filesystem`.

See [object-storage.ts](apps/web/lib/object-storage.ts) and [upload-pipeline.ts](apps/web/lib/upload-pipeline.ts).

### Observability

`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` enable optional AI SDK chat tracing; `LANGFUSE_BASE_URL` selects the Langfuse host. Without both keys, instrumentation is disabled. `LANGFUSE_RECORD_CONTENT=false` disables AI SDK input/output recording. This flag should not be treated as a general redaction guarantee for every tool argument or log. The separate OpenAI-client analysis pipeline does not use this chat telemetry configuration.

## Product behavior

### Uploads and extraction

The UI creates a contract, then uploads its file to `/api/contracts/:id/upload`. Project context uploads use `/api/projects/:id/context`.

The shared pipeline checks ownership at the route boundary, bounds multipart input, and validates file size, MIME type, and signatures. Files are limited to **4 MiB**. PDF text uses the PDF.js proxy from `unpdf`, `.doc`/`.docx` extraction uses `word-extractor`, images use Tesseract OCR, and plain text is decoded directly.

PDF pages are read sequentially, with at most 500 pages and 2,000,000 extracted characters. Images are limited to 25 megapixels before decoding. DOCX archives are inspected before expansion, with limits of 16 MiB expanded data and 2,000 entries. OCR allows one active job and one queued job; its 150-second deadline includes queue wait. The upload deadline also covers reading the request and storing the file. These bounds do not provide parser process isolation.

Scanned PDFs are detected through low text density; their pages are **not** rasterized for OCR. Contract and context uploads reject extraction failures or empty text. Usable but low-quality extraction can be stored with a warning. Original bytes go to object storage, while extracted text and metadata go to PostgreSQL. Reuploads replace active contract text and invalidate current analysis state; prior file records remain until deletion.

### Analysis and projects

`POST /api/contracts/:id/analyze` performs analysis inside the request. It claims a generation lease, loads the owner-scoped contract, and reuses a current result unless forced. Project context is included in the prompt.

The prompt includes up to 15,000 contract characters, preserving the beginning and end when shortened. Context is limited to eight documents, up to 3,000 characters each within an 8,000-character total text budget; the per-document bound is applied in SQL, so the prompt builder assembles rather than re-trims. Coverage and extraction warnings are retained with the result; this is not full-document coverage for long inputs.

Output passes through JSON parsing, schema validation, supported normalization, and a bounded repair path. Provider/request failures can use OpenRouter fallback; semantic validation failures do not trigger another provider solely to retry invalid analysis. The final database transaction checks the contract revision before storing the analysis and marking it `ANALYZED`. Contract/context changes invalidate previous results as current, while historical analyses remain accessible. The view includes parties, obligations, regional comparisons, fees, term dates, and the generated disclaimer. Provider-reported input/output token counts are stored, including JSON repair calls when usage is available.

Project detail returns 50 contracts and 50 context documents per page, with independent `contractsOffset` and `contextOffset` query parameters. Contract detail returns 50 analysis records per page using `analysisOffset`; the UI can load older records. `contractsHasMore`, `contextHasMore`, and `analysesHasMore` indicate continuation.

### Chat and tools

Temporary chat does not persist a thread or messages to the application database. It can be used anonymously or while signed in; provider processing and optional tracing are separate from thread persistence. Saved chat requires authentication and persists ordered user/assistant message pairs. Its model history is reconstructed from the database rather than trusted browser copies.

URL prompts (`/?q=...`) populate a draft after privacy acknowledgement and require the user to press Send.

Admission is shared across instances through PostgreSQL. Signed-in users may start 30 requests per hour with two concurrent runs; anonymous visitors share 10 requests per hour and one concurrent run. The global defaults are 1,000 requests per UTC day and eight concurrent runs, configurable using `CHAT_DAILY_REQUEST_LIMIT` and `CHAT_CONCURRENCY_LIMIT`. Rejected requests return 429 with `Retry-After`; unavailable admission storage returns 503. These are request limits, not exact monetary spending caps.

The default personality is `bare-llm`; signed-in users can select `signloop-assistant`. The answering model decides when to invoke tools:

| Tool                               | Behavior                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_web`                       | Returns search leads. Brave/Firecrawl return links and snippets; Gemini also returns a brief.                                                                                   |
| `read_url`                         | Reads page/PDF text through a hosted reader and registers a numbered source.                                                                                                    |
| `http_get`                         | Fetches a public URL directly and registers the response as a source.                                                                                                           |
| `list_contracts` / `read_contract` | Lists and reads only the signed-in user's contracts. Sequential and keyword excerpts are bounded to 12,000 characters; truncated keyword results include a continuation offset. |
| `generate_image`                   | Calls the available primary image model; image bytes are attached to the reply rather than replayed to the text model.                                                          |

Signed-in temporary and saved chats expose the research and contract tools. Image availability is checked separately. Missing integration keys can still cause tool errors. Anonymous chat exposes no tools. Retrieved document/page text is marked as untrusted; those textual markers are not an authorization boundary.

Saved and temporary replies use the same SDK-backed replay schema. Replay is compacted to 20,000 serialized characters before persistence, preserving complete tool exchanges and shortened evidence. Source catalogs travel independently through temporary requests and responses, capped at 64 sources and 16,000 serialized characters. SQL bounds legacy replay projections before returning rows; canonical prompt history remains bounded. Follow-up citation IDs retain the catalog when it fits the history budget.

Text and tool activity stream as newline-delimited JSON. The final source footer lists fetched sources and any valid references to retained source numbers. Citation markers are normalized, but a source's presence does not prove that it supports the answer. The numerical check compares decimals/grouped thousands against web text fetched during the current turn. It does not cover contract evidence or earlier-turn evidence and does not verify the meaning of a numerical claim.

New saved images are stored in `chat_attachments` and served through an ownership-checked route. Temporary images remain in browser conversation state. Saved chat initially loads the newest 50 messages, with older messages on demand; dashboard collections also use pages of 50.

### Request budgets

| Operation               | Current implementation                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analysis                | 120-second per-request client timeout; 270-second operation deadline; 300-second route budget.                                                                                                           |
| Chat                    | 260-second generation deadline; 275-second request deadline; 300-second route budget.                                                                             |
| Chat tool loop          | Ten model steps; final step disables tools. Per-turn limits: three search executions, five page reads, five direct HTTP fetches, two image generations, ten contract reads with two cached keyword-search documents.           |
| Provider stream opening | 20-second deadline per candidate until meaningful content/tool output; metadata-only streams retain the deadline. Opening events are capped at 256. |
| Direct HTTP             | 30 seconds, five redirects, 2 MiB response bytes, and 12,000 returned characters.                                                                                 |

Provider fallback can occur when opening a model step fails; an already-opened step is not replayed on another provider. SDK automatic retries are disabled in chat and analysis; application-level fallback/repair still exists. Incomplete saved chat runs are not persisted. A completed answer whose persistence fails is shown with an unsaved warning.

Budget sources: [chat.ts](apps/web/lib/chat.ts), [chat route](apps/web/app/api/chat/route.ts), [analysis route](apps/web/app/api/contracts/[id]/analyze/route.ts), and [chat-tools.ts](apps/web/lib/chat-tools.ts).

## Persistence and operations

Primary tables are `projects`, `contracts`, `analyses`, `context_documents`, `contract_files`, `user_settings`, `chat_threads`, `chat_messages`, and `chat_attachments`. `generation_operations` holds expiring inference leases; `chat_admissions` and `chat_request_budgets` enforce shared chat admission; `storage_deletions` is the object-deletion outbox; `schema_migrations` tracks applied SQL files.

The [migration runner](apps/web/db/migrations.js) discovers numbered SQL files, uses an advisory lock, and records each migration in the same transaction as its changes. Runtime bootstrap and the standalone command use that runner. Migration 012 adds relationship constraints/cascades, revision invalidation, the deletion outbox, and generation leases; 013 adds attachments; 014 adds extraction warnings; 015 adds index coverage for the chat contract listing and the deletion outbox; 016 adds admission budgets and cleanup claims/backoff. Legacy relationship violations can leave constraints unvalidated with warnings rather than deleting old rows.

Before uploading bytes, the server records a cleanup intent that becomes eligible after one hour. Successful file persistence cancels that intent in the same transaction; failed or interrupted uploads leave it for cleanup. An uncertain commit does not trigger immediate object deletion. Database deletion enqueues object cleanup transactionally. Delete routes attempt cleanup after responding; failed items remain queued. From `apps/web`, using configured database and storage credentials:

```bash
bun run storage:cleanup
```

Cleanup atomically claims due rows with expiring leases and processes four objects concurrently. Failed deletions back off from one minute to at most one day so newer work can proceed. Acknowledgments require the claim token. The command continues while full batches of eligible work remain. Vercel Cron calls `/api/cron/storage-cleanup` daily at 03:00 UTC; the route processes bounded batches, and later runs pick up remaining work. Set a random `CRON_SECRET` in the production Vercel environment to authorize those requests. Deletion requests and the manual command can also process due items.

## Deployment

Root [vercel.json](vercel.json) configures:

- Install: `bun install --frozen-lockfile --linker hoisted`.
- Build: `bunx turbo build --filter=web`.
- Output: `apps/web/.next`.
- Cron: daily storage-deletion outbox cleanup, authenticated with `CRON_SECRET`.

Keep the hoisted linker so repository-root framework discovery can resolve Next.js. The build command does not apply migrations. Run migrations against the intended environment before setting `SKIP_SCHEMA_BOOTSTRAP=1`. API output traces include SQL migration files through [next.config.js](apps/web/next.config.js).

The configured ignore command considers changes under `apps/web`, `packages`, and the listed root build/dependency configuration files; a root README/AGENTS-only commit is eligible to skip deployment. The repository configuration does not establish the current state of a live deployment.

## Known limitations and remaining work

- Larger uploads and parser process isolation remain unimplemented. Size/page/dimension guards reduce resource exposure but cannot prove arbitrary parser inputs harmless.
- Rendering speedups, constellation initialization, and candidate index removals still need profiling or production database evidence; they were deliberately excluded from this implementation.
- Live provider credentials, extraction quality on real documents, and deployed infrastructure require verification outside the mocked/unit test suite.

For contributor commands and persistence invariants, see [AGENTS.md](AGENTS.md).
