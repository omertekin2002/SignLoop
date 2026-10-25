import {
  assistantMessageForClient,
  toPublicChatMessage,
} from "@/lib/chat-public-message";
import { appendWebSourcesToMessage } from "@repo/chat-engine/web-citations";
import { NextResponse, after } from "next/server";
import { flushTelemetry, isTelemetryEnabled } from "@/lib/telemetry";
import { auth } from "@/lib/auth";
import {
  generateChatReply,
  generateChatReplyStream,
  type ChatMessage,
  type ChatReply,
} from "@/lib/chat";
import { GeminiWebSearchError } from "@repo/chat-engine/gemini-search";
import { WebSearchError } from "@repo/chat-engine/web-search";
import {
  boundCanonicalChatHistory,
  MAX_AGENT_STATE_CHARACTERS,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_REQUEST_BODY_BYTES,
  MAX_CHAT_DOCUMENT_REQUEST_BODY_BYTES,
  parseBoundedJsonRequest,
  parseClientChatMessages,
  parseLatestClientUserMessage,
} from "@/lib/chat-policy";
import {
  DEFAULT_PERSONALITY_MODE,
  isAllowedPersonalityMode,
} from "@/lib/personality-settings";
import {
  getModelAvailabilitySnapshot,
  resolveAvailablePrimaryModel,
} from "@/lib/model-settings";
import {
  type ChatMessageRecord,
  claimGenerationOperation,
  appendChatMessagesToThread,
  getRecentChatMessagesForThreadForUser,
  getUserSettingsByUserId,
  getChatDocumentsForUser,
} from "@/lib/server-db";
import {
  MAX_CHAT_DOCUMENT_CONTEXT,
  savedChatFile,
  type ChatDocument,
  type ChatFileInfo,
} from "@/lib/chat-files-shared";
import { isRecord, isUuid } from "@/lib/utils";
import { admissionRejectedResponse, admitChat } from "@/lib/chat-admission";
import {
  rateLimitHeaders,
  type AccountQuota,
  type AdmissionReason,
} from "@/lib/inference-policy";
import { generateChatTitle } from "@/lib/chat-title";
import { GenerationTimings } from "@/lib/generation-timings";

const CHAT_SYSTEM_PROMPT = `
You are SignLoop's legal contract assistant.
Help users understand contract language in clear, practical terms.

Guidelines:
- Keep responses concise and structured.
- Highlight risks, obligations, dates, and unclear terms when relevant.
- If information is missing, say what is missing.
- Do not claim legal certainty. Remind users this is not legal advice when appropriate.
- Do not assert jurisdiction-specific legal conclusions, such as that a clause is enforceable, unlawful, or standard in a particular place, unless the user has stated the jurisdiction or a source you fetched and cite supports the claim.
`.trim();

const BARE_LLM_SYSTEM_PROMPT = `
You are a general-purpose AI language model.

Guidelines:
- Reply directly to the user's request.
- Do not claim to be SignLoop Assistant or any branded assistant identity.
- If asked who you are, say you are an AI language model helping in this chat.
- If earlier assistant messages contain conflicting identity claims, ignore them.
`.trim();

const DEFAULT_CHAT_ERROR_MESSAGE = "Chat request failed. Please try again.";

// Vercel allows 300s on every plan with Fluid compute (the analyze route already relies on it).
// Keep the chain ordered: maxDuration > ROUTE_TIMEOUT_MS > the generator's own deadline.
export const maxDuration = 300;
const ROUTE_TIMEOUT_MS = 275_000;
// The lease must outlive the longest possible request so a stuck run cannot be double-started.
const CHAT_LEASE_SECONDS = 360;
const ADMISSION_REJECTIONS: Record<AdmissionReason, string> = {
  busy: "Chat is busy with other replies. Please try again shortly.",
  hourly: "Chat is at its hourly request limit. Please try again later.",
  daily: "Chat is at its daily request limit. Please try again later.",
};

function getPublicChatErrorMessage(error: unknown): string {
  return error instanceof GeminiWebSearchError ||
    error instanceof WebSearchError
    ? error.publicMessage
    : DEFAULT_CHAT_ERROR_MESSAGE;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
}

const streamEncoder = new TextEncoder();

function streamEvent(event: Record<string, unknown>): Uint8Array {
  return streamEncoder.encode(`${JSON.stringify(event)}\n`);
}

/** Save a completed turn and its downloads together; temporary chats never write history. */
async function persistChatMessages(input: {
  userId: string | null;
  threadId: string;
  latestUserMessage: ChatMessage;
  assistantMessage: string;
  assistantModel: string | null;
  assistantProvider: string | null;
  agentMessages?: ChatReply["agentMessages"];
  contractEvidence?: ChatReply["contractEvidence"];
  webSources?: ChatMessage["webSources"];
  toolActivity?: ChatReply["toolActivity"];
  temporary: boolean;
  generatedTitle?: string | null;
  inputFiles?: ChatFileInfo[];
  generatedFiles?: ChatReply["files"];
  signal: AbortSignal;
}): Promise<ChatMessageRecord[]> {
  if (input.temporary) {
    return [];
  }

  if (!input.userId) {
    throw new Error("Unauthorized");
  }

  // Naming can still be running when the answer finishes; honor cancellation during that wait.
  input.signal.throwIfAborted();

  return appendChatMessagesToThread({
    userId: input.userId,
    threadId: input.threadId,
    generatedTitle: input.generatedTitle,
    ...(input.generatedFiles?.length
      ? { generatedFiles: input.generatedFiles }
      : {}),
    messages: [
      {
        role: "user",
        content: input.latestUserMessage.content,
        ...(input.inputFiles?.length
          ? { metadata: { files: input.inputFiles } }
          : {}),
      },
      {
        role: "assistant",
        content: input.assistantMessage,
        // Persist the generating model/provider so the label survives re-hydration and reloads.
        // These values are handed straight through: appendChatMessagesToThread serializes the
        // metadata itself, and JSON.stringify already drops undefined properties, so the
        // parse(stringify(…)) round-trip these fields used to take produced a byte-identical
        // result at the cost of cloning the largest object in the turn one extra time.
        metadata: {
          model: input.assistantModel,
          provider: input.assistantProvider,
          agentMessages: input.agentMessages ?? [],
          // Never default: an explicit empty list vouches that no contract was read.
          contractEvidence: input.contractEvidence,
          webSources: input.webSources ?? [],
          toolActivity: input.toolActivity ?? [],
          ...(input.generatedFiles?.length
            ? {
                files: input.generatedFiles.map((file) =>
                  savedChatFile(file, input.threadId),
                ),
              }
            : {}),
        },
      },
    ],
  });
}

/**
 * Saved threads reload their tool exchanges from the database, so only temporary chat needs them
 * echoed back — it has no server-side history, and without this the next turn sees a transcript
 * with no record that any tool ran. Oversized transcripts are dropped here rather than sent for
 * the client to discard.
 */
function toTemporaryAgentMessages(
  reply: ChatReply,
  temporary: boolean,
): ChatReply["agentMessages"] | undefined {
  if (!temporary || !reply.agentMessages?.length) return undefined;
  return JSON.stringify(reply.agentMessages).length <=
    MAX_AGENT_STATE_CHARACTERS
    ? reply.agentMessages
    : undefined;
}

/** Build the final event, using saved URLs or temporary inline downloads according to persistence. */
function toDoneStreamEvent(input: {
  reply: ChatReply;
  message: string;
  temporary: boolean;
  persisted?: boolean;
  storedMessages: ChatMessageRecord[];
  quota?: AccountQuota;
}): Record<string, unknown> {
  const { reply, message, temporary, persisted = true } = input;

  return {
    type: "done",
    storedMessages: input.storedMessages.map(toPublicChatMessage),
    message,
    provider: reply.provider,
    model: reply.model,
    mode: temporary ? "temporary-chat" : "chat",
    persisted: temporary ? undefined : persisted,
    agentMessages: toTemporaryAgentMessages(reply, temporary),
    webSearchQuery: reply.webSearch?.query ?? null,
    webSearchAttempts: reply.webSearch?.attemptedQueries ?? [],
    webSearchSuccessfulCount: reply.webSearch?.successfulSearches ?? 0,
    webSources: reply.webSearch?.sources ?? [],
    toolActivity: reply.toolActivity ?? [],
    // The account quota as of this request's admission, so the client can update without a refetch.
    quota: input.quota,
    ...(temporary && reply.files?.length
      ? {
          documents: reply.files.map(
            ({ data: _data, ...document }) => document,
          ),
        }
      : {}),
    ...(reply.files?.length
      ? {
          files:
            !temporary && persisted
              ? (input.storedMessages.find(
                  (message) => message.role === "assistant",
                )?.files ?? [])
              : reply.files.map(({ text: _text, ...file }) => file),
        }
      : {}),
  };
}

/** Authenticate before bounded parsing, then run a temporary or owner-scoped saved chat turn. */
export async function POST(req: Request) {
  const timings = new GenerationTimings("chat");
  let release: (() => Promise<void>) | null = null;
  let releaseAdmission: (() => Promise<void>) | null = null;
  let streaming = false;
  let endGeneration = () => {};
  let storedMessages: ChatMessageRecord[] = [];
  const disconnect = new AbortController();
  const titleController = new AbortController();
  const operationSignal = AbortSignal.any([
    req.signal,
    disconnect.signal,
    AbortSignal.timeout(ROUTE_TIMEOUT_MS),
  ]);
  // Spans buffer in memory; export them once the response (including a stream) has finished.
  if (isTelemetryEnabled) after(flushTelemetry);
  try {
    const declaredContentLength = Number(req.headers.get("content-length"));
    if (
      Number.isFinite(declaredContentLength) &&
      declaredContentLength > MAX_CHAT_DOCUMENT_REQUEST_BODY_BYTES
    ) {
      return NextResponse.json(
        { error: "Chat request body is too large." },
        { status: 413 },
      );
    }

    // Authenticate from request headers before buffering any body bytes. Anonymous callers keep
    // the original small budget, including when Content-Length is omitted or understates the body.
    const { userId } = await timings.measure("auth", () => auth());
    const maxBodyBytes = userId
      ? MAX_CHAT_DOCUMENT_REQUEST_BODY_BYTES
      : MAX_CHAT_REQUEST_BODY_BYTES;
    if (
      Number.isFinite(declaredContentLength) &&
      declaredContentLength > maxBodyBytes
    )
      return NextResponse.json(
        { error: "Chat request body is too large." },
        { status: 413 },
      );

    const parsedBody = await parseBoundedJsonRequest<unknown>(
      req,
      maxBodyBytes,
      operationSignal,
    );
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.error },
        { status: parsedBody.status },
      );
    }
    const body = parsedBody.value;
    const isTemporaryChat = isRecord(body) && body.temporary === true;
    timings.enabled = !isTemporaryChat;
    // Search, page reading, and direct HTTP fetches are server-side invariants for authenticated
    // chats, so clients cannot disable them. Anonymous temporary chats get none of them, to protect
    // the private search quotas and to keep unauthenticated traffic off outbound fetches.
    // Contract tools follow the signed-in user, since they only ever expose that user's own files.
    const enableWebSearch = Boolean(userId);

    if (!userId && !isTemporaryChat) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const threadId =
      isRecord(body) && typeof body.threadId === "string"
        ? body.threadId.trim()
        : "";

    if (!isTemporaryChat && !threadId) {
      return NextResponse.json(
        { error: "threadId is required." },
        { status: 400 },
      );
    }

    // Reject malformed thread ids before they reach the uuid-typed persist query, which would
    // otherwise throw 22P02 and surface as a raw 500 after the reply was already generated.
    if (!isTemporaryChat && !isUuid(threadId)) {
      return NextResponse.json(
        { error: "Chat thread not found" },
        { status: 404 },
      );
    }

    const parsedMessages = isTemporaryChat
      ? parseClientChatMessages(body)
      : parseLatestClientUserMessage(body);
    if (!parsedMessages.ok) {
      return NextResponse.json(
        { error: parsedMessages.error },
        { status: parsedMessages.status },
      );
    }

    let conversationMessages = parsedMessages.messages;
    const latestUserMessage = conversationMessages.at(-1)!;
    if (
      !userId &&
      conversationMessages.some((message) => message.documents?.length)
    )
      return NextResponse.json(
        { error: "Sign in to attach files." },
        { status: 401 },
      );
    let inputFiles: ChatFileInfo[] = [];
    let currentDocuments: ChatDocument[] = [];
    let persistedMessages: ChatMessageRecord[] = [];

    if (userId && !isTemporaryChat) {
      release = await timings.measure("lease", () =>
        claimGenerationOperation(userId, "chat", threadId, CHAT_LEASE_SECONDS),
      );
      if (!release)
        return NextResponse.json(
          { error: "A reply is already running in this chat." },
          { status: 409 },
        );
      // Read the owner-scoped thread before admission, so a missing or foreign thread costs no quota.
      const recentMessages = await timings.measure("history", () =>
        getRecentChatMessagesForThreadForUser(
          userId,
          threadId,
          MAX_CHAT_MESSAGES - 1,
        ),
      );
      if (!recentMessages)
        return NextResponse.json(
          { error: "Chat thread not found" },
          { status: 404 },
        );
      persistedMessages = recentMessages;
      if (latestUserMessage.fileIds?.length) {
        currentDocuments = await getChatDocumentsForUser(
          userId,
          threadId,
          latestUserMessage.fileIds,
        );
        if (new Set(latestUserMessage.fileIds).size !== currentDocuments.length)
          return NextResponse.json(
            { error: "An attached file was not found in this chat." },
            { status: 400 },
          );
        inputFiles = currentDocuments.map((file) =>
          savedChatFile(file, threadId),
        );
      }
    }

    if (
      currentDocuments.reduce((total, file) => total + file.text.length, 0) >
      MAX_CHAT_DOCUMENT_CONTEXT
    )
      return NextResponse.json(
        { error: "Attach at most 400,000 extracted characters per message." },
        { status: 413 },
      );

    let quota: AccountQuota | undefined;
    try {
      const admission = await timings.measure("admission", () =>
        admitChat(userId),
      );
      if ("retryAfter" in admission)
        return admissionRejectedResponse(
          admission,
          ADMISSION_REJECTIONS[admission.reason],
        );
      releaseAdmission = admission.release;
      quota = admission.quota;
    } catch {
      return NextResponse.json(
        { error: "Chat is temporarily unavailable. Please try again shortly." },
        { status: 503 },
      );
    }

    const [settings, modelSnapshot] = await Promise.all([
      userId
        ? timings.measure("settings", () => getUserSettingsByUserId(userId))
        : Promise.resolve(null),
      // Anonymous chat uses the configured default model and gets no image tool, so it skips the
      // upstream /models round-trip rather than blocking on a 5s timeout for nothing.
      userId
        ? timings.measure("model_discovery", () =>
            getModelAvailabilitySnapshot({
              deferRefresh: (refresh) => after(refresh),
              onSource: (source) => {
                timings.discoverySource = source;
              },
            }),
          )
        : Promise.resolve({
            availablePrimaryModels: [],
            imageGenerationAvailable: false,
          }),
    ]);

    const selectedPrimaryModel = userId
      ? resolveAvailablePrimaryModel(
          settings?.primaryModel,
          modelSnapshot.availablePrimaryModels,
        )
      : undefined;

    if (!isTemporaryChat) {
      const canonicalMessages = boundCanonicalChatHistory(
        persistedMessages
          .filter(
            (message) =>
              message.role === "user" || message.role === "assistant",
          )
          .map((message): ChatMessage => ({
            role: message.role,
            content: message.content,
            agentMessages: message.agentMessages,
            contractEvidence: message.contractEvidence,
            webSources: message.webSources,
            ...(message.files?.length
              ? { fileIds: message.files.map((file) => file.id) }
              : {}),
          })),
        latestUserMessage.content.length,
      );
      conversationMessages = [...canonicalMessages, latestUserMessage];
    }

    const requestedFileIds = conversationMessages.flatMap(
      (message) => message.fileIds ?? [],
    );
    const currentIds = new Set(currentDocuments.map((file) => file.id));
    const priorFileIds = requestedFileIds.filter((id) => !currentIds.has(id));
    const allDocuments = isTemporaryChat
      ? conversationMessages.flatMap((message) => message.documents ?? [])
      : [
          ...currentDocuments,
          ...(priorFileIds.length
            ? await getChatDocumentsForUser(userId!, threadId, priorFileIds)
            : []),
        ];
    let documentCharacters = 0;
    const documents: ChatDocument[] = [];
    const documentById = new Map(allDocuments.map((file) => [file.id, file]));
    for (const message of [...conversationMessages].reverse()) {
      for (const id of message.fileIds ??
        message.documents?.map((file) => file.id) ??
        []) {
        const file = documentById.get(id);
        if (
          !file ||
          documents.some((item) => item.id === id) ||
          documentCharacters + file.text.length > MAX_CHAT_DOCUMENT_CONTEXT
        )
          continue;
        documents.push(file);
        documentCharacters += file.text.length;
      }
    }

    const personality =
      settings?.personality && isAllowedPersonalityMode(settings.personality)
        ? settings.personality
        : DEFAULT_PERSONALITY_MODE;
    const promptMessages: ChatMessage[] =
      personality === "bare-llm"
        ? [
            { role: "system", content: BARE_LLM_SYSTEM_PROMPT },
            ...conversationMessages,
          ]
        : [
            { role: "system", content: CHAT_SYSTEM_PROMPT },
            ...conversationMessages,
          ];

    // Start naming alongside the answer. Persist both in the first-turn transaction so the
    // client's existing thread-list refresh sees the title immediately after completion.
    // Catch here so a title failure never rejects (or creates an unhandled rejection during)
    // an otherwise successful reply.
    const generatedTitle =
      !isTemporaryChat && persistedMessages.length === 0
        ? generateChatTitle(latestUserMessage.content, {
            primaryModel: selectedPrimaryModel,
            signal: AbortSignal.any([operationSignal, titleController.signal]),
          }).catch((error) => {
            if (!operationSignal.aborted && !titleController.signal.aborted)
              console.error("Chat title generation failed:", error);
            return null;
          })
        : Promise.resolve(null);

    timings.outcome = "error";
    endGeneration = timings.start("generation");
    const wantsStream = isRecord(body) && body.stream === true;
    if (wantsStream) {
      streaming = true;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          disconnect.abort();
        },
        async start(controller) {
          let sentDone = false;

          try {
            for await (const chunk of generateChatReplyStream(promptMessages, {
              primaryModel: selectedPrimaryModel,
              signal: operationSignal,
              enableWebSearch,
              enableDocuments: Boolean(userId),
              documents,
              enableUrlReader: enableWebSearch,
              enableHttpFetch: enableWebSearch,
              contractsUserId: userId,
              recordTelemetry: !isTemporaryChat,
              onTiming: isTemporaryChat ? undefined : timings.mark,
              enableImageGeneration: modelSnapshot.imageGenerationAvailable,
              userId,
            })) {
              if (req.signal.aborted || disconnect.signal.aborted) {
                return;
              }

              if (chunk.type === "delta") {
                if (chunk.text) timings.mark("first_output");
                controller.enqueue(
                  streamEvent({ type: "delta", text: chunk.text }),
                );
                continue;
              }

              if (chunk.type === "tool") {
                timings.mark("first_output");
                controller.enqueue(streamEvent(chunk));
                continue;
              }

              endGeneration();
              timings.mark("generation_complete");
              const assistantMessage = appendWebSourcesToMessage(
                chunk.reply.message,
                chunk.reply.webSearch?.sources ?? [],
                {
                  readThisTurn: chunk.reply.readSources,
                  figures: chunk.reply.figures,
                },
              );

              // The full answer has already been streamed to (and rendered by) the client, so a
              // persistence failure here must NOT flip the visible message to an error state.
              // Log it, mark the done event as unpersisted, and still finalize the turn.
              let persisted = true;
              try {
                const title = await timings.measure(
                  "title_wait",
                  () => generatedTitle,
                );
                storedMessages = await timings.measure(
                  "persistence",
                  async () =>
                    persistChatMessages({
                      userId,
                      threadId,
                      latestUserMessage,
                      assistantMessage,
                      agentMessages: chunk.reply.agentMessages,
                      contractEvidence: chunk.reply.contractEvidence,
                      webSources: chunk.reply.webSearch?.sources,
                      toolActivity: chunk.reply.toolActivity,
                      assistantModel: chunk.reply.model ?? null,
                      assistantProvider: chunk.reply.provider ?? null,
                      temporary: isTemporaryChat,
                      generatedTitle: title,
                      inputFiles,
                      generatedFiles: chunk.reply.files,
                      signal: operationSignal,
                    }),
                );
              } catch (persistError) {
                if (
                  req.signal.aborted ||
                  disconnect.signal.aborted ||
                  isAbortError(persistError)
                ) {
                  return;
                }
                persisted = false;
                console.error("Chat persist (stream) failed:", persistError);
              }

              controller.enqueue(
                streamEvent(
                  toDoneStreamEvent({
                    reply: chunk.reply,
                    message: assistantMessageForClient(
                      assistantMessage,
                      storedMessages,
                      persisted && !isTemporaryChat,
                    ),
                    temporary: isTemporaryChat,
                    persisted,
                    storedMessages,
                    quota,
                  }),
                ),
              );
              timings.outcome = persisted ? "success" : "unpersisted";
              sentDone = true;
            }

            if (
              !sentDone &&
              !req.signal.aborted &&
              !disconnect.signal.aborted
            ) {
              controller.enqueue(
                streamEvent({
                  type: "error",
                  error: "Chat stream ended before completion.",
                }),
              );
            }
          } catch (streamError) {
            if (
              req.signal.aborted ||
              disconnect.signal.aborted ||
              isAbortError(streamError)
            ) {
              return;
            }

            console.error("Chat stream error:", streamError);
            controller.enqueue(
              streamEvent({
                type: "error",
                error: getPublicChatErrorMessage(streamError),
              }),
            );
          } finally {
            endGeneration();
            titleController.abort();
            const endRelease = timings.start("release");
            await release?.().catch((error) =>
              console.error("Chat lease release failed", error),
            );
            await releaseAdmission?.().catch((error) =>
              console.error("Chat admission release failed", error),
            );
            endRelease();
            // The client cancels its reader after done, possibly while release is pending.
            timings.finish(!sentDone && operationSignal.aborted);
            if (!disconnect.signal.aborted) controller.close();
          }
        },
      });

      timings.mark("response_ready");
      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          ...rateLimitHeaders(quota),
        },
      });
    }

    const {
      message,
      provider,
      model,
      webSearch,
      agentMessages,
      contractEvidence,
      toolActivity,
      readSources,
      figures,
      files,
    } = await generateChatReply(promptMessages, {
      primaryModel: selectedPrimaryModel,
      signal: operationSignal,
      enableWebSearch,
      enableDocuments: Boolean(userId),
      documents,
      enableUrlReader: enableWebSearch,
      enableHttpFetch: enableWebSearch,
      contractsUserId: userId,
      recordTelemetry: !isTemporaryChat,
      onTiming: isTemporaryChat ? undefined : timings.mark,
      enableImageGeneration: modelSnapshot.imageGenerationAvailable,
      userId,
    });
    endGeneration();
    timings.mark("generation_complete");
    const assistantMessage = appendWebSourcesToMessage(
      message,
      webSearch?.sources ?? [],
      { readThisTurn: readSources, figures },
    );

    let persisted = true;
    if (!isTemporaryChat) {
      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const title = await timings.measure("title_wait", () => generatedTitle);
        storedMessages = await timings.measure("persistence", async () =>
          persistChatMessages({
            userId,
            threadId,
            latestUserMessage,
            assistantMessage,
            agentMessages,
            contractEvidence,
            webSources: webSearch?.sources,
            toolActivity,
            assistantModel: model ?? null,
            assistantProvider: provider ?? null,
            temporary: false,
            generatedTitle: title,
            inputFiles,
            generatedFiles: files,
            signal: operationSignal,
          }),
        );
      } catch (persistError) {
        // Match the streaming path: inference already succeeded, so keep the useful reply while
        // clearly telling the client not to treat the in-memory turn as canonical history.
        persisted = false;
        console.error("Chat persist (non-stream) failed:", persistError);
      }
    }

    timings.outcome = persisted ? "success" : "unpersisted";
    timings.mark("response_ready");
    return NextResponse.json(
      {
        message: assistantMessageForClient(
          assistantMessage,
          storedMessages,
          persisted && !isTemporaryChat,
        ),
        storedMessages: storedMessages.map(toPublicChatMessage),
        provider,
        model,
        mode: isTemporaryChat ? "temporary-chat" : "chat",
        persisted: isTemporaryChat ? undefined : persisted,
        agentMessages: toTemporaryAgentMessages(
          { agentMessages } as ChatReply,
          isTemporaryChat,
        ),
        toolActivity: toolActivity ?? [],
        webSearchQuery: webSearch?.query ?? null,
        webSearchAttempts: webSearch?.attemptedQueries ?? [],
        webSearchSuccessfulCount: webSearch?.successfulSearches ?? 0,
        webSources: webSearch?.sources ?? [],
        quota,
        ...(isTemporaryChat && files?.length
          ? { documents: files.map(({ data: _data, ...document }) => document) }
          : {}),
        ...(files?.length
          ? {
              files:
                persisted && !isTemporaryChat
                  ? (storedMessages.find(
                      (message) => message.role === "assistant",
                    )?.files ?? [])
                  : files.map(({ text: _text, ...file }) => file),
            }
          : {}),
      },
      { headers: rateLimitHeaders(quota) },
    );
  } catch (error: unknown) {
    timings.outcome = "error";
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: getPublicChatErrorMessage(error) },
      { status: 500 },
    );
  } finally {
    if (!streaming) endGeneration();
    const endRelease = timings.start("release");
    if (!streaming) titleController.abort();
    if (!streaming)
      await release?.().catch((error) =>
        console.error("Chat lease release failed", error),
      );
    if (!streaming)
      await releaseAdmission?.().catch((error) =>
        console.error("Chat admission release failed", error),
      );
    if (!streaming) {
      endRelease();
      timings.finish(operationSignal.aborted);
    }
  }
}
