# Source provenance

The chat engine is no longer copied into this service. The agent loop, tools, provider routing, replay, source catalogs, citations, and their tests come from [`@repo/chat-engine`](../../packages/chat-engine), which `apps/web` uses too, so engine fixes reach both apps at once.

This app was the standalone SLgateway repository, imported into the SignLoop monorepo with `git subtree` at SLgateway `0987fe2`. Its earlier history, including the record of which SignLoop modules were copied and how each was adapted, is preserved in this directory's git history (`git log -- apps/gateway/SOURCE_PROVENANCE.md`).

Gateway-only code stays here: the HTTP boundary, configuration, chat policy, advisory model discovery, the provider chain and its fallback policy, the concurrency limit, and allowlisted logging. Behavior the gateway needs and the web app does not is an opt-in engine option: no output cap (`maxOutputTokens: null`), silenced AI SDK stream errors (`onStreamError`), and abort reasons such as a deadline's `TimeoutError` surfaced as thrown (`rethrowAbortReason`). The golden [contract tests](./tests/contract.test.ts) keep the public API unchanged.
