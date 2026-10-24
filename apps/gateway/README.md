# SignLoop Chat Service

A standalone, stateless HTTP service running SignLoop's agentic chat engine on Bun and Render. The answering model can search, read web pages and PDFs, fetch public API data, and optionally generate images across multiple model steps. Callers retain their own conversation history.

The engine is synced with SignLoop commit `61c90b508a789cee988acdded52b2d1a8c82ee69` ([PR #10](https://github.com/omertekin2002/SignLoop/pull/10)). See [SOURCE_PROVENANCE.md](./SOURCE_PROVENANCE.md) for the copied modules and standalone adaptations.

## Architecture

```text
client sends text + optional tool history/source catalog
  -> Bun.serve HTTP boundary
  -> per-process concurrency gate + bounded request validation
  -> authoritative UTC time + server-controlled provider order (optional primary, Gemini, OpenRouter)
  -> SignLoop ToolLoopAgent (at most 10 model steps)
       -> search_web: Brave / Firecrawl / Gemini search leads
       -> read_url: Firecrawl / Jina page or PDF text
       -> http_get: direct public HTTP(S) API data
       -> generate_image: optional primary image endpoint
       -> completed tool results returned to the answering model
       -> next-step provider fallback when needed
  -> citation normalization + bounded replay state
  -> JSON or NDJSON response
```

There is no database, WorkOS/Clerk authentication, saved-thread API, contract datastore, upload handling, or persistent disk requirement. Private contract tools and their egress guard, chat naming, usage quotas, and SignLoop's UI remain in SignLoop. Optional generated images are returned inline; the service does not store them. Langfuse tracing is not enabled in this service.

## Local setup

Bun is pinned to **1.3.11** in `package.json` and `render.yaml`.

```sh
bun --version
bun install --frozen-lockfile
cp .env.example .env
bun run check-types
bun run test
bun run dev
```

Configure a complete primary provider URL/key pair, `GEMINI_API_KEY`, an OpenRouter key, or any combination. Each model step tries them in that order. Gemini is called through its native API. OpenAI-compatible endpoints (primary and OpenRouter) must support **streaming Responses API function calls and tool-result continuation**. This is also required for non-streaming HTTP clients: the service collects the same internal streaming agent loop into a JSON reply.

Use `bun run start` in production. The listener binds to `0.0.0.0:10000` by default. `/healthz` checks process liveness without calling providers.

## Configuration

Configuration is validated once at startup. Provider URLs, credentials, models, and image availability are controlled by the server; callers cannot override them.

| Variable                     | Default                                               | Purpose                                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRIMARY_LLM_BASE_URL`       | unset                                                 | Optional OpenAI-compatible API base URL, including `/v1` where applicable, tried first. Set together with its key.                                                       |
| `PRIMARY_LLM_API_KEY`        | unset                                                 | Optional primary credential.                                                                                                                                                    |
| `PRIMARY_LLM_MODEL`          | `gpt-6.1-sol`                                        | Primary answering model. Set an explicit model advertised by your endpoint that supports Responses tools. Default use emits a safe startup warning. |
| `OPENROUTER_API_KEY`         | unset                                                 | Enables the OpenRouter fallback, tried after Gemini and primary.                                                                                                                |
| `OPENROUTER_BASE_URL`        | `https://openrouter.ai/api/v1`                        | OpenRouter-compatible endpoint.                                                                                                                                                 |
| `OPENROUTER_FALLBACK_MODELS` | `openrouter/free`                                      | Ordered comma-separated model IDs, deduplicated, maximum five.                                                                                                                  |
| `WEB_SEARCH_PROVIDER`        | automatic                                             | Optional `brave`, `firecrawl`, or `gemini`. Without an override, configured keys are preferred in that order.                                                                   |
| `BRAVE_SEARCH_API_KEY`       | unset                                                 | Enables Brave search.                                                                                                                                                           |
| `FIRECRAWL_API_KEY`          | unset                                                 | Enables Firecrawl search and page/PDF reading.                                                                                                                                  |
| `GEMINI_API_KEY`             | unset                                                 | Enables Gemini chat generation, tried after the primary, and Google-grounded Gemini search.                                                                                                 |
| `GEMINI_CHAT_MODEL`          | `gemini-3.8-flash`                                    | Gemini answering model. Runs with high thinking and a 90-second opening deadline.                                                                                               |
| `GEMINI_SEARCH_MODEL`        | `gemini-2.5-flash`                                    | Independent of the answering model.                                                                                                                                             |
| `JINA_API_KEY`               | unset                                                 | Optional credential for Jina Reader. The reader is also used without a key.                                                                                                     |
| `ENABLE_IMAGE_GENERATION`    | `false`                                               | Opt-in image tool. Requires primary configuration and positive model discovery.                                                                                                 |
| `IMAGE_GENERATION_MODEL`     | `gpt-image-2.5-sunburst`                              | Primary image model; must be advertised by `/models`.                                                                                                                           |
| `PUBLIC_SERVICE_URL`         | `RENDER_EXTERNAL_URL`, then `http://localhost:<PORT>` | Public service identity in provider headers.                                                                                                                                    |
| `APP_NAME`                   | `SignLoop Chat Service`                               | Provider `X-Title` identity.                                                                                                                                                    |
| `PORT`                       | `10000`                                               | Listening port, 1–65535. Render supplies this.                                                                                                                                  |
| `MAX_CONCURRENT_REQUESTS`    | `4`                                                   | Active requests per process. Excess requests receive `429`.                                                                                                                     |
| `REQUEST_TIMEOUT_MS`         | `275000`                                              | Whole-request deadline, including body reading and provider discovery; maximum 3600000. Agent generation has its own 260-second ceiling.                                        |
| `CORS_ALLOWED_ORIGINS`       | empty                                                 | Explicit comma-separated HTTP(S) browser origins. Wildcards are rejected.                                                                                                       |
| `BUN_VERSION`                | `1.3.11` in Blueprint                                 | Render runtime pin.                                                                                                                                                             |
| `NODE_ENV`                   | `production` in Blueprint                             | Render environment.                                                                                                                                                             |

All answering providers request high reasoning effort through a shared policy. OpenAI-compatible primary and OpenRouter requests explicitly apply it to model aliases without requesting reasoning summaries. Native Gemini chat uses high thinking. Gemini search uses the maximum supported thinking budget for Gemini 2.5 (24,576 tokens for Flash variants, 32,768 for Pro), with another 2,048 output tokens available for its grounded brief; Gemini 3+ uses high thinking with a 32,768-token output budget. Provider deadlines still apply.

An explicit search provider selects one integration; it is not a retry chain between search providers. Search failure becomes a tool error so the model can refine its query or explain the limitation. Page reading prefers Firecrawl and can fall back to Jina within a shared deadline. `http_get` needs no search key.

Image generation is disabled unless explicitly enabled and discovery confirms the configured image model. The Render Blueprint enables it and requires `PRIMARY_LLM_BASE_URL` and `PRIMARY_LLM_API_KEY`. An unavailable discovery endpoint does not expose the image tool. Images use the primary endpoint even when text generation has fallen back to OpenRouter.

Before syncing this Blueprint to an existing service, manually provision both primary credentials in Render. Render prompts for `sync: false` values only when creating a Blueprint and ignores newly added `sync: false` entries on later updates; see [Render's secret-value instructions](https://render.com/docs/blueprint-spec#prompting-for-secret-values). Keep `ENABLE_IMAGE_GENERATION=false` on services without the credentials until they are provisioned.

## Public API

- `GET /healthz` → `{"ok":true,"service":"signloop-chat-service"}`
- `POST /v1/chat` → JSON or NDJSON chat response.

The chat route remains public, with no API key required. Send `Content-Type: application/json`.

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Find and read sources about the latest changes."
    }
  ],
  "stream": false,
  "research": "auto"
}
```

`messages` must be a non-empty array of `user` and `assistant` messages, ending in a user message. Each requires non-empty string `content`. Client system messages and model/provider selection are rejected. `stream` defaults to `true`; `research` defaults to `auto`.

### Research modes

- **`auto`** exposes `search_web`, `read_url`, and `http_get`. The answering model decides whether to use them, including on follow-up questions and non-English prompts. There is no keyword classifier or mandatory preprocessing search.
- **`always`** requires non-empty source text fetched successfully during this turn through `read_url` or a successful `http_get`. Search snippets and retained history do not satisfy the requirement. Tool use is required until evidence is obtained. If the completed run has no fresh evidence, the service returns `research_unavailable`. Tool progress streams immediately, but answer deltas are buffered until the run succeeds.
- **`never`** disables all three external research tools. Previously supplied history remains available. Optional image generation is controlled separately by server configuration.

The strict check establishes that fresh evidence was retrieved. It does not establish that every claim in the answer is supported.

### JSON response

```json
{
  "message": "Answer [1]\n\nSources:\n- [1] [Source title](<https://example.com/page>)",
  "provider": "gemini",
  "model": "gemini-3.8-flash",
  "webSearch": {
    "query": "model-selected query",
    "attemptedQueries": ["model-selected query"],
    "successfulSearches": 1,
    "sources": [
      {
        "number": 1,
        "title": "Source title",
        "url": "https://example.com/page"
      }
    ]
  },
  "webSearchQuery": "model-selected query",
  "webSearchAttempts": ["model-selected query"],
  "webSearchSuccessfulCount": 1,
  "webSources": [
    { "number": 1, "title": "Source title", "url": "https://example.com/page" }
  ],
  "toolActivity": [
    {
      "id": "call-1",
      "tool": "read_url",
      "query": "https://example.com/page",
      "status": "complete"
    }
  ],
  "readSources": [1],
  "figures": "ok"
}
```

`provider` is `gemini`, `primary-openai-compatible`, or `openrouter`. It identifies the last selected text provider; different completed steps can use different providers after fallback. `agentMessages`, when present, contains the SDK assistant/tool exchanges for future turns: complete tool-call/result pairs, with assistant prose removed because `message` already carries the answer. They are bounded and omitted when there is no tool exchange to replay.

`webSources` is the conversation's bounded source catalog. Each entry carries an explicit, stable citation `number`; citations `[n]`, `readSources`, and the footer all refer to these numbers, not to array positions. `readSources` lists the numbers fetched during the current turn. The footer lists fetched sources and valid references to earlier sources, preserving their original numbers. When a new page needs room, the oldest inherited entries not read during this turn are retired; their numbers are never reused, so a citation to a retired source simply gets no footer entry. Numbers can therefore have gaps and need not start at 1. Search leads do not enter the catalog until fetched. A direct page/API read can produce sources with no search query. If no catalog exists, `webSearch`/`webSearchQuery` are null and legacy search arrays/counts are empty/zero; `toolActivity` still records searches that produced only unread leads.

`figures` is `ok`, `no-evidence`, or `unmatched`. SignLoop's heuristic checks measured numbers against text fetched during this turn and may append a notice. It is not semantic fact checking and does not validate earlier-turn evidence.

### Stateful conversations over a stateless service

For each successful reply, retain `message`, `agentMessages`, and `webSources`. On the next request, send the tool state and source catalog on that assistant message:

```js
history.push({
  role: "assistant",
  content: reply.message,
  ...(reply.agentMessages ? { agentMessages: reply.agentMessages } : {}),
  webSources: reply.webSources,
});
history.push({ role: "user", content: "Explain that source in more detail." });
```

Bound the history before sending it. Compact inline generated-image data to a text placeholder before truncating assistant content to 4000 characters. Retain only the newest source catalog, sent back unchanged, and trim oldest complete user/assistant pairs to satisfy both character and UTF-8 request-byte limits. The updated otekin client implements this.

The service replays each assistant turn as its compacted tool exchanges followed by its canonical `content`, so the answer is sent to the model once and in full. Older clients that stored replay with assistant prose (including the 4000-character answer copies from the previous gateway release) still work: the prose is stripped from replay and the tool pairs are kept.

Catalogs from older releases have no `number` fields. They are still accepted and read positionally (entry `i` is `[i + 1]`), so existing citations keep their meaning; the reply returns the catalog with explicit numbers, and new sources continue after the highest one. A catalog may mix both forms only if every resulting number is unique. If adding numbers requires pruning during migration, the highest-numbered entry is retained so even a turn with no new reads preserves the allocation watermark, including an exhausted number range. If JSON escaping makes that single numbered entry exceed the cap, its optional snippet is omitted while its title, exact URL, and citation number are preserved.

Clients that render their own source list must resolve citations by each entry's `number`, falling back to position only for numberless entries. The companion fix is in [otekin PR #4](https://github.com/omertekin2002/otekin/pull/4), including terminal hyperlinks and legacy catalogs; see [companion client compatibility](./SOURCE_PROVENANCE.md#companion-client). Installations based on `12b4de8` (version `0.1.8`) still use positions for that display, so distribute the updated client before deploying this gateway release. Its history forwarding already preserves the new fields.

Malformed or oversized replay/catalog fields are dropped, including catalogs with duplicate or invalid numbers (positive safe integers only). Replay accepts only SDK assistant/tool text and tool exchanges, never system/user instruction roles, media, or approval parts. This prevents SDK media downloads outside the public HTTP tool's guards. Client-supplied replay is conversation context, not trusted proof of research. Legacy text-only clients continue to work but cannot retain full tool evidence between turns.

### Streaming response

The content type is `application/x-ndjson; charset=utf-8`. Each line is one JSON object:

```json
{"type":"tool","activity":{"id":"call-1","tool":"read_url","query":"https://example.com/page","status":"running"}}
{"type":"tool","activity":{"id":"call-1","tool":"read_url","query":"https://example.com/page","status":"complete"}}
{"type":"delta","text":"Answer [1]"}
{"type":"done","message":"Answer [1]\n\nSources:\n- [1] [Source](<https://example.com/page>)","provider":"gemini","model":"gemini-3.8-flash"}
```

The `done` event carries the same metadata as the JSON response. Tool statuses are `running`, `complete`, or `error`. Clients should tolerate new event types. Treat **`done.message` as the canonical answer**: citation normalization, source footers, and figure notices happen after generation. A connected stream ends with one `done` or `error` event. Disconnects cancel provider/tool work.

Errors after the stream opens retain HTTP 200 and appear as a terminal event:

```json
{
  "type": "error",
  "error": "Chat request failed. Please try again.",
  "code": "generation_unavailable"
}
```

### Provider fallback and limits

Each model step tries the optional primary, then Gemini (`GEMINI_API_KEY`), then each OpenRouter model in order. The startup log line `generation_providers` lists the configured order. Primary and Gemini failures always move to the next provider; OpenRouter stops early on request or credential errors (400, 401, 403, 405, 413, 422). Once a request moves on, its later steps stay on the provider that answered.

Primary model discovery remains advisory for text generation: a valid model list that excludes the configured model skips primary; unknown availability still attempts it. Definite results are cached for five minutes; unknown results for one minute, so a slow or unsupported `/models` endpoint does not delay every request. Text and image model checks run concurrently. All discovery and generation share the request deadline.

The agent uses SignLoop's 20-second stream-opening guard per candidate. Gemini gets 90 seconds, because it streams nothing while it thinks. Metadata-only streams do not satisfy it. A failed opening can move to the next configured provider; an already-opened step is never replayed. Completed tool results survive a provider switch on a later step. SDK automatic retries are disabled. Incomplete output, token-limit finishes, and EOF without full completion are rejected.

| Limit                                                      |                                            Value |
| ---------------------------------------------------------- | -----------------------------------------------: |
| Messages per request                                       |                                               30 |
| Characters per message                                     |                                             4000 |
| Total history, including serialized replay/source metadata |                                 60000 characters |
| HTTP request body                                          |                  128 KiB, incrementally enforced |
| Model steps                                                |                    10; final step disables tools |
| Output tokens                                              |             provider's own limit; no service cap |
| Search executions                                          |                      3 distinct queries per turn |
| Page reads / direct HTTP fetches                           |        5 each per turn; repeated URLs are cached |
| Page / API text                                            |                      12000 characters per result |
| Tool replay                                                | 20000 serialized characters, at most 36 messages |
| Source catalog                                             |         64 entries / 16000 serialized characters |
| Image generations                                          |                          2 per turn when enabled |
| Image payload                                              |                        8 MiB of base64 per image |

Replay keeps no assistant prose; the canonical message supplies the answer once. Tool results inside replay are excerpted at 2000 characters, and older complete exchanges are dropped first when replay exceeds its budget.

Both catalog caps (entry count and serialized size, including the `number` fields) are enforced on every reply. Inherited sources are retired oldest first to make room; sources fetched during the current turn, including re-reads of inherited pages, are never retired. Only the current turn's own reads can therefore fill the catalog, which in practice means several near-maximum-length addresses within one turn. Before fetching, `read_url` and `http_get` check whether the address could still be numbered and otherwise return a tool error without contacting the reader or target; `search_web` makes the same check for a minimal entry. If a fetched page's real title or redirected address does not fit, the tool returns the same error and the page is not cited. Pages already in the catalog can always be read again as fresh evidence. In `always` mode, a turn that could not fetch any fresh evidence still fails with `research_unavailable`.

Public HTTP fetching validates each redirect and resolved socket address, blocks private/reserved IPs and credential-bearing URLs, and bounds response size. Requests to hosted readers also validate the requested URL. Retrieved text is fenced as untrusted data; `<<`/`>>` runs inside it are broken up so a page cannot forge the fence markers.

### Errors and request IDs

| Status                | Stable code              | Meaning                                                |
| --------------------- | ------------------------ | ------------------------------------------------------ |
| 400 / 404 / 413 / 415 | `invalid_request`        | Invalid input, route, size, or content type.           |
| 429                   | `service_busy`           | Per-process capacity exhausted; inspect `Retry-After`. |
| 502                   | `research_unavailable`   | Strict research did not obtain fresh evidence.         |
| 502                   | `generation_unavailable` | Provider exhaustion or incomplete/failed generation.   |
| 504                   | `request_timeout`        | Request or generation deadline expired.                |
| 500                   | `generation_unavailable` | Unexpected boundary failure.                           |

Responses carry `X-Request-ID`; safe incoming IDs are propagated. Structured logs retain request timing, counts, and allowlisted provider failure metadata. They omit prompts, research bodies, credentials, provider URLs, raw upstream error messages, and stack traces. SDK default error/warning logging is suppressed.

The concurrency gate applies per process. CORS is browser interoperability, not access control. For shared quotas or access restrictions, use an external gateway/rate limiter. Every caller can initiate provider work, including image generation if enabled.

## Deployment and validation

[render.yaml](./render.yaml) installs the locked dependencies, type-checks, runs tests, starts Bun, and checks `/healthz`. No database or persistent disk is needed. Add integration credentials through Render environment settings. `GEMINI_API_KEY` alone is a complete generation path. If you configure the optional primary, set `PRIMARY_LLM_MODEL` to a compatible model supported by your endpoint. Existing deployments explicitly configured with `REQUEST_TIMEOUT_MS=180000` retain that shorter deadline until updated.

```sh
curl --fail http://localhost:10000/healthz
curl --fail-with-body --silent --show-error \
  http://localhost:10000/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":false}'
curl --no-buffer http://localhost:10000/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Read https://example.com and summarize it"}],"research":"always"}'
```

The normal suite uses mocked providers, including real SDK Responses serialization and HTTP-boundary tests. A live provider smoke test is opt-in and incurs provider usage:

```sh
RUN_LIVE_TESTS=1 bun run test -- tests/live.test.ts
```

Local tests do not establish deployed provider compatibility. Before rollout, check a simple reply, a search/read/answer cycle, a follow-up with replay, strict research failure, cancellation, and an optional image request against the configured deployment.

Conversation content goes to the selected generation providers. Search queries go to the selected search integration; URLs and page content are processed through readers or public HTTP targets. Optional image prompts go to the primary image provider. The gateway itself retains no conversations after requests; provider retention is separate. The updated otekin client retains chat state in memory and writes requested generated images to temporary local PNG files.
