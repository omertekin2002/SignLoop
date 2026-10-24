# SignLoop

SignLoop is a personal AI-assisted contract workspace built with Next.js 16, React, WorkOS AuthKit, PostgreSQL, and OpenAI-compatible model providers. Users can upload contracts, request structured analysis, organize supporting documents in projects, and use temporary or saved chat. Every account has its own workspace; organizations and team membership are not used.

The Bun/Turborepo repository contains one application, `apps/web`, plus shared ESLint and TypeScript configuration packages. There is no separate API server or background inference worker: API Route Handlers perform extraction, analysis, and chat orchestration.

## Local setup

Requirements: **Node.js 22.11+** (required by AuthKit) and **Bun 1.3.11**, the version pinned in [package.json](package.json).

From the repository root:

```bash
bun install
cp apps/web/.env.local.example apps/web/.env.local
```

Fill in the WorkOS and database credentials, then configure a primary model endpoint and/or OpenRouter for inference. Optional integrations in the example are commented out; enable only those you intend to use. The environment file belongs in `apps/web`, not the repository root.

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

Tests include the [contract analysis evaluations](apps/web/evals/README.md), which replay hand-written model outputs through the production analysis path. They make no provider calls.

Database tests skip unless `SIGNLOOP_TEST_DATABASE_URL` is supplied. The supported disposable-database workflow is:

```bash
cd apps/web
bun run test:integration
```

It initializes local PostgreSQL, applies migrations, runs database ownership/concurrency tests, and removes the temporary database. It never uses `POSTGRES_URL`. The default binary directory is `/opt/homebrew/opt/postgresql@16/bin`; set `POSTGRES_BIN` for another installation. If `SIGNLOOP_TEST_DATABASE_URL` is already set, the script skips the temporary cluster and runs the same suites against that database instead; it must be an empty, disposable `signloop_test` database on `localhost`, such as a `postgres:16` container. This is separate from testing against production credentials or live model services.

GitHub Actions ([ci.yml](.github/workflows/ci.yml)) runs on pull requests and pushes to `main`. One job installs dependencies with Vercel's hoisted linker, then runs lint, type checking, tests, and the build, and checks the OCR build traces; none of them needs secrets or environment files. A second job runs `bun run test:integration` against an empty `postgres:16` service container.

## Configuration

Start with [apps/web/.env.local.example](apps/web/.env.local.example). Actual behavior is defined in the linked implementation files below.

### Authentication and database

- `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` configure WorkOS AuthKit. Use credentials from the same WorkOS environment.
- `WORKOS_COOKIE_PASSWORD` encrypts session cookies and must be at least 32 characters. Generate it with `openssl rand -base64 32`; keep it secret and stable across instances. Rotating it signs users out.
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI` is the complete callback URL (`http://localhost:3000/callback` locally). Register the exact URL in your WorkOS application's Redirects settings. Use the deployed HTTPS origin in production.
- `POSTGRES_URL` is used by runtime pooled SQL operations.
- `POSTGRES_URL_NON_POOLING` is used by the standalone migration client.
- `SKIP_SCHEMA_BOOTSTRAP=1` disables runtime migration checks. Otherwise the first database operation in a process runs pending migrations using the shared runner, with initialization reused by later operations. This is lazy initialization, not a startup job.

In the WorkOS dashboard, enable the personal sign-in methods you want (for example email/password or Google), set the **Initiate login URI** to `http://localhost:3000/sign-in`, and the **Sign-out URI** to `http://localhost:3000/`. Configure equivalent HTTPS URLs for production. Organization creation, SSO, directory sync, and invitations are not needed.

Vercel preview deployments use a WorkOS **staging** environment because production environments reject wildcard redirects on `vercel.app`. Set `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and `WORKOS_COOKIE_PASSWORD` for Vercel's Preview environment, and leave `NEXT_PUBLIC_WORKOS_REDIRECT_URI` unset there. On previews, [auth-redirect.ts](apps/web/lib/auth-redirect.ts) sends the callback back to the deployment or branch hostname that started sign-in. In the staging environment, register `https://signloop-*-<team-slug>.vercel.app/callback` as a redirect URI and `https://signloop-*-<team-slug>.vercel.app/` as a sign-out URI. Preview accounts are staging accounts, separate from production accounts.

`/sign-in` and `/sign-up` start AuthKit's hosted flow and set its PKCE cookie. `/callback` verifies the flow and returns to `/dashboard`. The root page and auth routes are public in [proxy.ts](apps/web/proxy.ts). API routes pass through session verification and enforce authorization in their handlers: unauthenticated requests receive JSON `401` responses, `/api/chat` permits anonymous temporary chat, and the cleanup cron uses its bearer secret.

This migration starts with **new WorkOS accounts**, without importing or linking Clerk accounts. [017_auth_identities.sql](apps/web/db/migrations/017_auth_identities.sql) adds a stable application user ID and a unique WorkOS identity mapping. Each new WorkOS user receives a fresh personal workspace; provider metadata, email addresses, external IDs, and organization IDs cannot claim another workspace. Existing owner IDs and data are left untouched. [auth.ts](apps/web/lib/auth.ts) resolves the stable owner ID for all authenticated API operations, preserving the existing owner-scoped SQL. The callback also requires database access to initialize the mapping. Apply migrations before deployment if `SKIP_SCHEMA_BOOTSTRAP=1` is enabled.

For the cutover, replace Clerk environment variables with the four WorkOS variables above in local and Vercel environments, register the production redirect/login/logout URLs, and redeploy. Existing Clerk sessions are not WorkOS sessions; users sign in again. Hosted form branding is configured in WorkOS rather than in app components. See the [AuthKit Next.js guide](https://workos.com/docs/authkit/nextjs) for provider setup.

### Model providers

- `PRIMARY_LLM_BASE_URL` enables the primary provider; include the API prefix, normally `/v1`.
- `PRIMARY_LLM_API_KEY` may be empty only if that endpoint intentionally accepts unauthenticated requests.
- `PRIMARY_LLM_MODEL` supplies the default for callers without an explicit model, including anonymous chat. Its current fallback is `gemini-3-flash`.
- `OPENROUTER_API_KEY` enables fallback inference; `OPENROUTER_BASE_URL` defaults to `https://openrouter.ai/api/v1`.
- `NEXT_PUBLIC_APP_URL` supplies app URL metadata in provider request headers, defaulting to `http://localhost:3000`.

Signed-in chat and analysis select the saved model if available, otherwise the first eligible model returned by the primary `/models` endpoint. They do not use `PRIMARY_LLM_MODEL` as the selector's default. Discovery is cached per process for 60 seconds, or 10 seconds following failure; ordinary selector/settings reads reuse this cache. Saving an unavailable primary model forces one fresh check; explicit `GET /api/settings?refreshModels=1` remains available. Anonymous chat skips discovery and uses the configured default.

Generation requests can reuse the last successful discovery for one additional minute while a shared refresh runs. Both generation routes retain that refresh with Next `after(promise)` so the serverless request lifecycle supports its completion. The hard limit is **120 seconds from successful discovery completion**; failed refreshes never extend it. Cold or hard-expired requests await discovery (or reuse a still-valid 10-second negative cache). Successful empty lists replace earlier successes, including image availability. Settings and model-selection validation do not use the generation grace window; explicit refresh still bypasses all cached results and joins any refresh already running. Provider fallback and first-useful-chunk deadlines still apply if a recently discovered model becomes unavailable. This is an instance-local optimization, so cold instances still incur discovery latency.

If no primary model is available to an authenticated request, it uses the configured OpenRouter chain. When OpenRouter is configured, users can also pin `openrouter/free`, which skips primary inference. The current fallback order and image-model identifier live in [model-settings.ts](apps/web/lib/model-settings.ts). Image generation is offered only to signed-in users when primary discovery advertises `gpt-image-2.5-sunburst`.

Chat endpoints must support Responses API function tools and tool-result continuation. Analysis uses Responses JSON output, with a compatibility retry when JSON mode is unsupported. Provider compatibility tests use mocks; passing them does not establish that deployed credentials or live providers work.

All text generation requests high reasoning effort, including chat, conversation titles, analysis, and OpenRouter fallbacks. The Gemini search helper requests `HIGH` thinking on Gemini 3+; Gemini 2.5 uses its maximum supported thinking-token budget with additional output headroom for the search brief. Providers must support the requested reasoning controls; non-reasoning models cannot acquire reasoning support from this setting. Image generation keeps its separate image settings.

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

`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` enable optional AI SDK chat tracing; `LANGFUSE_BASE_URL` selects the Langfuse host. Without both keys, instrumentation is disabled. `LANGFUSE_RECORD_CONTENT=true` explicitly opts into saved-chat AI tracing, which can include prompts, replies, and tool inputs/results. By default, AI tracing is disabled; temporary chats disable it even when this flag is true. Trace retention is configured in Langfuse independently of workspace deletion. This does not redact unrelated application logs. The separate OpenAI-client analysis pipeline does not use this chat telemetry configuration.

Saved-chat and analysis requests also emit one `console.info("Generation timings", record)` entry in the application server logs, independently of Langfuse. Filter local server output or deployment function logs for `Generation timings`; no additional monitoring service or configuration is needed. Temporary chats, including signed-in temporary chats, emit no timing record or provider timing hooks. New timing records contain only the route name, fixed outcome/source labels, and durations; they contain no prompts, contract text, tool arguments, token counts, credentials, model names, or account/resource IDs.

- `phasesMs` measures auth, lease, canonical chat history or analysis gate/contract reads, admission, settings, model discovery, analysis project context, generation, persistence, and lease/admission release. Independent settings/discovery/context reads remain concurrent **after** ownership and admission gates, so overlapping phase durations must not be added together. `model_discovery` measures the request's wait, not background refresh duration; `discoverySource` distinguishes `cache`, `negative-cache`, `stale-cache`, `refresh`, `in-flight`, and `unconfigured`.
- `milestonesMs` holds offsets from route entry. Chat `provider_start` is the first provider stream attempt; `provider_first_useful` is the first nonempty text/reasoning delta, tool input/call, or file, excluding opening metadata. Their difference includes failed startup attempts and fallback. `first_output` is the first delta/tool event enqueued by the streaming route, not browser receipt or paint. Each milestone is recorded once across providers and tool steps. Analysis uses a non-streaming provider API, so its `generation` duration includes the full provider response and validation; it does not report provider first-output milestones.
- `generation_complete` precedes persistence. Chat `title_wait` measures any remaining naming wait after the answer, separately from persistence. `response_ready` marks response construction, which is early for streaming chat. The single final record is emitted after stream processing and release finish (or non-streaming request cleanup), with `totalMs` and `success`, `unpersisted`, `error`, `cancelled`, `rejected`, or `reused` outcome. Skipped phases/milestones are absent. Durations use a monotonic clock and are rounded to 0.1 ms. Background refresh time is outside this total. Late timings are never put into response headers or NDJSON events.

For latency comparisons, group saved-chat samples by `discoverySource` and compare discovery wait, provider startup-to-useful time, first-output offset, and total separately. Use equivalent cold/warm workloads and record deployment/provider conditions. Controlled-clock tests verify behavior and lifecycle accounting; they do not establish a production latency improvement.

## Product behavior

### Uploads and extraction

The UI creates a contract, then uploads its file to `/api/contracts/:id/upload`. Project context uploads use `/api/projects/:id/context`.

The shared pipeline checks ownership at the route boundary, bounds multipart input, and validates file size, MIME type, and signatures. Files are limited to **4 MiB**. PDF text uses the PDF.js proxy from `unpdf`, `.doc`/`.docx` extraction uses `word-extractor`, images use Tesseract OCR, and plain text is decoded directly. OCR runs tesseract.js in a worker thread with the English LSTM model from the pinned `@tesseract.js-data/eng` package; nothing is downloaded or cached on disk at runtime.

PDF pages are read sequentially, with at most 500 pages and 2,000,000 extracted characters. Images are limited to 25 megapixels before decoding. DOCX archives are inspected before expansion, with limits of 16 MiB expanded data and 2,000 entries. OCR allows one active job and one queued job; its 150-second deadline includes queue wait. If the OCR worker cannot start, or its thread dies, the upload returns 503 and the next upload starts a fresh worker. The upload deadline also covers reading the request and storing the file. These bounds do not provide parser process isolation.

Scanned PDFs are detected through low text density across the document. In an otherwise digital PDF, each page with fewer than 20 non-whitespace characters (typically an appended scanned schedule or signature page, but also a short cover page) is named in a warning, and the extraction confidence becomes the share of pages with more selectable text than that. Any text those pages do have is kept and analyzed. Scanned pages are **not** rasterized for OCR. Contract and context uploads reject extraction failures or empty text, and return 422 before storing anything when any extractor's text contains a NUL character (U+0000), which PostgreSQL text cannot hold. Usable but low-quality extraction can be stored with a warning, which the contract page shows before and after analysis. Original bytes go to object storage, while extracted text and metadata go to PostgreSQL. Reuploads replace active contract text and invalidate current analysis state; prior file records remain until deletion.

### Analysis and projects

`POST /api/contracts/:id/analyze` performs analysis inside the request. It claims a generation lease, loads the owner-scoped contract, and reuses a current result unless forced. Project context is included in the prompt.

The prompt includes up to 15,000 contract characters, preserving the beginning and end when shortened. Context is limited to eight documents, up to 3,000 characters each within an 8,000-character total text budget; the per-document bound is applied in SQL, so the prompt builder assembles rather than re-trims. Coverage and extraction warnings are retained with the result; this is not full-document coverage for long inputs.

Output passes through deterministic JSON parsing (including fences and trailing commas), schema validation, and supported normalization. Unrecoverable output is rejected without a model-based repair call, which could invent missing contract facts. Provider/request failures can use OpenRouter fallback; semantic validation failures do not trigger another provider solely to retry invalid analysis. The final database transaction checks the contract revision before storing the analysis and marking it `ANALYZED`. Contract/context changes invalidate previous results as current, while historical analyses remain accessible. The view includes parties, obligations, fees, term dates, and the generated disclaimer. Nothing collects a contract's jurisdiction yet, so the prompt asks for no regional or market comparisons and tells the model not to judge clauses under any jurisdiction's law or practice. The server also discards any comparisons the model returns and sets `comparisons_withheld`, which the view explains; comparisons never count as substantive analysis content. Reports saved earlier keep their comparisons, labelled as generated without a confirmed jurisdiction. Unknown renewal and notice terms remain null. Notice wording and units are preserved in `notice_period_text`; `notice_period_days` is populated only for explicit whole calendar-day durations. Existing numeric reports remain readable. Provider-reported input/output token counts are stored when usage is available.

Project detail returns 50 contracts and 50 context documents per page, with independent `contractsOffset` and `contextOffset` query parameters. Contract detail returns 50 analysis records per page using `analysisOffset`; the UI can load older records. `contractsHasMore`, `contextHasMore`, and `analysesHasMore` indicate continuation.

Contract detail offers **View source text** before or after analysis. This is plain extracted text (never source HTML or a PDF/OCR renderer), paged in passages of at most 6,000 Unicode code points through authenticated, owner-scoped `GET /api/contracts/:id/source`. Responses use `Cache-Control: private, no-store`. Extraction warnings remain visible; missing formatting, tables, or scanned content cannot be recovered by this viewer.

New red flags can include **View matched quotation**. The existing analysis call requests an exact quote and its contract segment; the server derives the contract ID, SHA-256 content revision, and zero-based, end-exclusive Unicode code point range. Verification requires an exact, unique match within the identified segment actually sent to the model (full text, head, or tail). It never searches project context or the omitted middle, normalizes whitespace/Unicode, or guesses between repeated quotations. Quotes are limited to 2,000 code points. Malformed, unsupported, or ambiguous evidence leaves the finding readable with “Verified source quotation unavailable.” Matching proves text provenance, not the correctness of the interpretation or legal conclusion.

Source receipts live in analysis JSON; no additional migration or text snapshot retention is required. Navigation rechecks the saved finding, ownership, report existence, current content hash, quotation, and excerpt coverage. Reuploads with different extracted text make historical source links unavailable (409); the current source remains accessible separately. Byte-identical text retains the same revision. Status changes, analysis saves, and project-context updates do not change this hash; the existing timestamp checks still reject completion after concurrent upload/context changes. Deletion removes source access and cascades report deletion. Reports retain their short quotations until those reports/contracts are deleted. Legacy reports stay readable and are never backfilled as verified against current text. Switching reports retires source requests; paging pins the selected content revision and late responses cannot replace another report’s passage.

### Chat and tools

Temporary chat does not persist a thread or messages to the application database. It can be used anonymously or while signed in; provider processing is separate from thread persistence, and temporary chats disable AI tracing. Opening Temporary chat preserves the current conversation and draft; starting a new temporary chat requires confirmation when either contains content. WorkOS identity changes still clear local state and query caches. Saved chat requires authentication and persists ordered user/assistant message pairs. Its model history is reconstructed from the database rather than trusted browser copies. Contract tool reads carry server-generated revision receipts, including dependencies inherited by follow-up answers. Receipts are checked against owner-scoped contracts when saving and replaying; changed, deleted, and unverifiable legacy evidence is withheld from model context while historical replies stay visible. Saving locks referenced contract rows to coordinate with uploads and deletion.

New saved chats receive a short AI-generated title from their first user message. Naming runs alongside the first reply using the same selected model, chat pipeline, and provider fallbacks, with tools disabled and an independent eight-second deadline. The title is saved with the first completed turn and appears in the sidebar's completion refresh. Existing or custom titles are preserved; if naming fails or times out, the reply still saves with the default title.

New saved-chat drafts create their server thread on first send. Stopping a send keeps a late creation ID available for retrying the same draft. Abandoning that draft instead attempts owner-scoped cleanup, which preserves threads containing messages or an active generation. Cleanup is best effort when the transport or session changes prevent it from completing.

URL prompts (`/?q=...`) populate a draft after privacy acknowledgement and require the user to press Send.

Chat and analysis share admission across instances through PostgreSQL, keyed by the stable application owner ID resolved from WorkOS. Signed-in users may start 30 combined requests per hour with two concurrent runs; anonymous visitors share 10 requests per hour and one concurrent run. The global defaults are 1,000 requests per UTC day and eight concurrent runs, configurable using `CHAT_DAILY_REQUEST_LIMIT` and `CHAT_CONCURRENCY_LIMIT`. Cached analysis reuse does not consume quota; forced analyses do. Saved chat checks the thread before admission, so a missing or foreign thread returns 404 without consuming quota. The existing `CHAT_*` environment names remain compatible and now govern both operations. The limits live in [inference-policy.ts](apps/web/lib/inference-policy.ts), which both enforcement and the usage report read. Rejected requests return 429 with a reason and `Retry-After` (see [Request budgets](#request-budgets)); unavailable admission storage returns 503. These are request limits, not exact monetary spending caps.

The default personality is `bare-llm`; signed-in users can select `signloop-assistant`. The answering model decides when to invoke tools:

| Tool                               | Behavior                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_web`                       | Returns search leads. Brave/Firecrawl return links and snippets; Gemini also returns a brief.                                                                                   |
| `read_url`                         | Reads page/PDF text through a hosted reader and registers a numbered source.                                                                                                    |
| `http_get`                         | Fetches a public URL directly and registers the response as a source.                                                                                                           |
| `list_contracts` / `read_contract` | Lists and reads only the signed-in user's contracts. Sequential and keyword excerpts are bounded to 12,000 characters; truncated keyword results include a continuation offset. |
| `generate_image`                   | Calls the available primary image model; image bytes are attached to the reply rather than replayed to the text model.                                                          |

Signed-in temporary and saved chats expose the research and contract tools. Image availability is checked separately. Missing integration keys can still cause tool errors. Anonymous chat exposes no tools. Retrieved document/page text is marked as untrusted; those textual markers are not an authorization boundary. The `signloop-assistant` prompt and the contract-tool instructions (given to either personality) tell the model not to assert jurisdiction-specific legal conclusions unless the user states the jurisdiction or a fetched, cited source supports them; this is an instruction, not an enforced check.

Saved and temporary replies use the same SDK-backed replay schema. Replay is compacted to 20,000 serialized characters before persistence, preserving complete tool exchanges and shortened evidence; assistant prose is replayed once from canonical message content under the ordinary history limits. Source catalogs travel independently through temporary requests and responses, capped at 64 sources and 16,000 serialized characters. New sources retire older inherited entries when needed, with stable citation numbers that are never reassigned to another source. Sources read during the current turn remain protected. SQL bounds legacy replay projections before returning rows; canonical prompt history remains bounded.

Text and tool activity stream as newline-delimited JSON. The final source footer lists fetched sources and any valid references to retained source numbers. Citation markers are normalized, but a source's presence does not prove that it supports the answer. The numerical check compares decimals/grouped thousands against web text fetched during the current turn. It does not cover contract evidence or earlier-turn evidence and does not verify the meaning of a numerical claim.

The chat client shows first useful text and changed tool status immediately, then coalesces subsequent text into 40 ms updates. A timer flushes buffered text even while the network is paused; terminal completion bypasses the timer and supplies the exact authoritative answer and metadata. Errors retain useful partial text, while Stop or leaving the chat cancels the reader and discards pending paints. This changes only client update frequency; the NDJSON protocol and persistence behavior are unchanged.

New saved images are stored in `chat_attachments` and served through an ownership-checked route. Temporary images remain in browser conversation state. Saved chat initially loads the newest 50 messages, with older messages on demand; dashboard collections also use pages of 50. Creating a chat or completing a saved reply refreshes only the first chat-list page and resets its pagination after that response arrives.

### Request budgets

| Operation               | Current implementation                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analysis                | 120-second per-request client timeout; 270-second operation deadline; 300-second route budget.                                                                                                                       |
| Chat                    | 260-second generation deadline; 275-second request deadline; 300-second route budget.                                                                                                                                |
| Chat tool loop          | Ten model steps; final step disables tools. Per-turn limits: three search executions, five page reads, five direct HTTP fetches, two image generations, ten contract reads with two cached keyword-search documents. |
| Provider stream opening | 20-second deadline per candidate until meaningful content/tool output; metadata-only streams retain the deadline. Opening events are capped at 256.                                                                  |
| Direct HTTP             | 30 seconds, five redirects, 2 MiB response bytes, and 12,000 returned characters.                                                                                                                                    |

Provider fallback can occur when opening a model step fails; an already-opened step is not replayed on another provider. SDK automatic retries are disabled in chat and analysis; application-level provider fallback and JSON-format compatibility retries still exist. Incomplete saved chat runs are not persisted. A completed answer whose persistence fails is shown with an unsaved warning.

Signed-in users can read the shared chat/analysis quota from `GET /api/usage`, which returns 401 when signed out and is sent with `Cache-Control: private, no-store`. It reads the admission tables without taking the admission lock, writes nothing, and never claims quota. The body is `{ account: { limit, used, remaining, resetAt, concurrency: { limit, inUse } }, shared: ["chat", "analysis"], service }`: `resetAt` is the end of the current clock hour, expired slots are not counted, and `service` is only a coarse `ok`, `busy`, or `exhausted`. Service-wide counts and the anonymous bucket are never reported.

For signed-in users, the usage endpoint and chat and analysis responses, including 429s, carry IETF draft rate-limit fields: `RateLimit-Policy: "account";q=30;w=3600` and `RateLimit: "account";r=<remaining>;t=<seconds until reset>`. The chat `done` event and 429 bodies also include the account `quota` object, as of admission or rejection. A 429 body names its `reason` (`busy`, `hourly`, or `daily`) and `resetAt`. `Retry-After` is the time until that reset plus up to 15 seconds of jitter; a busy wait is at most 30 seconds, or less when a held slot expires sooner. Settings shows the hourly allowance with a meter, the chat composer counts down from five remaining requests and disables Send at zero until the reset, and the analysis buttons show the remaining allowance. Anonymous temporary chat shows none of these.

Budget sources: [chat.ts](apps/web/lib/chat.ts), [chat route](apps/web/app/api/chat/route.ts), [analysis route](apps/web/app/api/contracts/[id]/analyze/route.ts), [chat-tools.ts](apps/web/lib/chat-tools.ts), [inference-policy.ts](apps/web/lib/inference-policy.ts), and the [usage route](apps/web/app/api/usage/route.ts).

## Persistence and operations

Primary tables are `projects`, `contracts`, `analyses`, `context_documents`, `contract_files`, `user_settings`, `chat_threads`, `chat_messages`, and `chat_attachments`. `generation_operations` holds expiring inference leases; `chat_admissions` and `chat_request_budgets` enforce combined chat/analysis admission; `storage_deletions` is the object-deletion outbox; `schema_migrations` tracks applied SQL files.

The [migration runner](apps/web/db/migrations.js) discovers numbered SQL files, uses an advisory lock, and records each migration in the same transaction as its changes. Runtime bootstrap and the standalone command use that runner. Migration 012 adds relationship constraints/cascades, revision invalidation, the deletion outbox, and generation leases; 013 adds attachments; 014 adds extraction warnings; 015 adds index coverage for the chat contract listing and the deletion outbox; 016 adds admission budgets and cleanup claims/backoff. Legacy relationship violations can leave constraints unvalidated with warnings rather than deleting old rows.

Before uploading bytes, the server records a cleanup intent that becomes eligible after one hour. Successful file persistence cancels that intent in the same transaction; failed or interrupted uploads leave it for cleanup. An uncertain commit does not trigger immediate object deletion. Database deletion enqueues object cleanup transactionally. Delete routes attempt cleanup after responding; failed items remain queued. From `apps/web`, using configured database and storage credentials:

```bash
bun run storage:cleanup
```

Cleanup atomically claims due rows with expiring leases and processes four objects concurrently. Failed deletions back off from one minute to at most one day so newer work can proceed. Acknowledgments require the claim token. The command continues while full batches of eligible work remain. Vercel Cron calls `/api/cron/storage-cleanup` daily at 03:00 UTC; its 240-second work deadline cancels remote deletes and stops dispatching new objects within a batch. Remaining claims are deferred, reserving time for database acknowledgments before the 300-second platform limit. Set a random `CRON_SECRET` in the production Vercel environment to authorize those requests. Deletion requests and the manual command can also process due items.

## Deployment

Root [vercel.json](vercel.json) configures:

- Install: `bun install --frozen-lockfile --linker hoisted`.
- Build: `bunx turbo build --filter=web`.
- Output: `apps/web/.next`.
- Cron: daily storage-deletion outbox cleanup, authenticated with `CRON_SECRET`.

Keep the hoisted linker so repository-root framework discovery can resolve Next.js. The build command does not apply migrations. Run migrations against the intended environment before setting `SKIP_SCHEMA_BOOTSTRAP=1`. API output traces include SQL migration files through [next.config.js](apps/web/next.config.js). The OCR upload routes leave tesseract.js unbundled and trace its worker modules, WebAssembly core builds, and English model; `bun run check:ocr-trace` in `apps/web` verifies those traces after a build.

The configured ignore command considers changes under `apps/web`, `packages`, and the listed root build/dependency configuration files; a root README/AGENTS-only commit is eligible to skip deployment. The repository configuration does not establish the current state of a live deployment.

## Known limitations and remaining work

- Larger uploads and parser process isolation remain unimplemented. Size/page/dimension guards reduce resource exposure but cannot prove arbitrary parser inputs harmless.
- Rendering speedups, constellation initialization, and candidate index removals still need profiling or production database evidence; they were deliberately excluded from this implementation.
- Live provider credentials, extraction quality on real documents, and deployed infrastructure require verification outside the mocked/unit test suite.

For contributor commands and persistence invariants, see [AGENTS.md](AGENTS.md).

Upload and contract-analysis clients request `Accept: application/vnd.signloop.progress+ndjson` for real lifecycle stages. Uploads report `uploading` while receiving/validating the file, `extracting` when text extraction starts, and `saving` before object storage and the transactional metadata write. Analysis reports `preparing` after ownership, lease and admission checks, then `analyzing` during validated generation and `saving` after result finalization. Leaving the contract page within the app keeps its analysis request running, invalidates the initiating account's cache on success, and suppresses late view callbacks. Uploads still cancel on close or navigation, releasing the visible operation immediately while an already-started creation finishes in the background so its ID can be cleaned up. Existing JSON callers and preflight HTTP errors retain their responses. The stream ends with one `result` containing the original `status`, `headers`, and JSON `body`; only a validated success after persistence and resource release completes the UI operation. Missing/malformed terminals and interrupted streams are errors. Cancellation propagates to extraction/generation and stops new writes where possible; a transaction already in flight may still commit, so refresh to confirm an interrupted operation before retrying. Stages indicate work starting, with no estimated percentage or page-level OCR progress.
