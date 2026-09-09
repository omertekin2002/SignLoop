import { toPublicChatMessage } from "@/lib/chat-public-message";
import { appendWebSourcesToMessage } from "@/lib/web-citations";
import { NextResponse, after } from "next/server";
import { flushTelemetry, isTelemetryEnabled } from "@/lib/telemetry";
import { auth } from "@clerk/nextjs/server";
import {
  generateChatReply,
  generateChatReplyStream,
  type ChatMessage,
  type ChatReply,
} from "@/lib/chat";
import { GeminiWebSearchError } from "@/lib/gemini-search";
import { WebSearchError } from "@/lib/web-search";
import {
  boundCanonicalChatHistory,
  MAX_AGENT_STATE_CHARACTERS,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_REQUEST_BODY_BYTES,
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
} from "@/lib/server-db";
import { isRecord, isUuid } from "@/lib/utils";

const CHAT_SYSTEM_PROMPT = `
You are SignLoop's legal contract assistant.
Help users understand contract language in clear, practical terms.

Guidelines:
- Keep responses concise and structured.
- Highlight risks, obligations, dates, and unclear terms when relevant.
- If information is missing, say what is missing.
- Do not claim legal certainty. Remind users this is not legal advice when appropriate.
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

function getPublicChatErrorMessage(error: unknown): string {
  return error instanceof GeminiWebSearchError || error instanceof WebSearchError
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

async function persistChatMessages(input: {
  userId: string | null;
  threadId: string;
  latestUserMessage: ChatMessage;
  assistantMessage: string;
  assistantModel: string | null;
  assistantProvider: string | null;
  agentMessages?: ChatReply["agentMessages"];
  webSources?: ChatMessage["webSources"];
  toolActivity?: ChatReply["toolActivity"];
  temporary: boolean;
}): Promise<ChatMessageRecord[]> {
  if (input.temporary) {
    return [];
  }

  if (!input.userId) {
    throw new Error("Unauthorized");
  }

  return appendChatMessagesToThread({
    userId: input.userId,
    threadId: input.threadId,
    messages: [
      { role: "user", content: input.latestUserMessage.content },
      {
        role: "assistant",
        content: input.assistantMessage,
        // Persist the generating model/provider so the label survives re-hydration and reloads.
        metadata: {
          model: input.assistantModel,
          provider: input.assistantProvider,
          agentMessages: JSON.parse(JSON.stringify(input.agentMessages ?? [])),
          webSources: JSON.parse(JSON.stringify(input.webSources ?? [])),
          toolActivity: JSON.parse(JSON.stringify(input.toolActivity ?? [])),
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
  return JSON.stringify(reply.agentMessages).length <= MAX_AGENT_STATE_CHARACTERS
    ? reply.agentMessages
    : undefined;
}

function toDoneStreamEvent(input: {
  reply: ChatReply;
  message: string;
  temporary: boolean;
  persisted?: boolean;
  storedMessages: ChatMessageRecord[];
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
  };
}

export async function POST(req: Request) {
  let release: (() => Promise<void>) | null = null;
  let streaming = false;
  let storedMessages: ChatMessageRecord[] = [];
  const disconnect = new AbortController();
  const operationSignal = AbortSignal.any([req.signal, disconnect.signal, AbortSignal.timeout(ROUTE_TIMEOUT_MS)]);
  // Spans buffer in memory; export them once the response (including a stream) has finished.
  if (isTelemetryEnabled) after(flushTelemetry);
  try {
    const declaredContentLength = Number(req.headers.get("content-length"));
    if (
      Number.isFinite(declaredContentLength) &&
      declaredContentLength > MAX_CHAT_REQUEST_BODY_BYTES
    ) {
      return NextResponse.json(
        { error: "Chat request body is too large." },
        { status: 413 },
      );
    }

    const parsedBody = await parseBoundedJsonRequest<unknown>(req);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.error },
        { status: parsedBody.status },
      );
    }
    const body = parsedBody.value;
    const isTemporaryChat = isRecord(body) && body.temporary === true;
    const { userId } = await auth();
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

    if (userId && !isTemporaryChat) {
      release = await claimGenerationOperation(userId, "chat", threadId, CHAT_LEASE_SECONDS);
      if (!release) return NextResponse.json({ error: "A reply is already running in this chat." }, { status: 409 });
    }

    const [settings, persistedMessages, modelSnapshot] = await Promise.all([
      userId ? getUserSettingsByUserId(userId) : Promise.resolve(null),
      userId && !isTemporaryChat
        ? getRecentChatMessagesForThreadForUser(
            userId,
            threadId,
            MAX_CHAT_MESSAGES - 1,
          )
        : Promise.resolve([]),
      // Anonymous chat uses the configured default model and gets no image tool, so it skips the
      // upstream /models round-trip rather than blocking on a 5s timeout for nothing.
      userId
        ? getModelAvailabilitySnapshot()
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
      if (persistedMessages === null) {
        return NextResponse.json(
          { error: "Chat thread not found" },
          { status: 404 },
        );
      }

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
            webSources: message.webSources,
          })),
        latestUserMessage.content.length,
      );
      conversationMessages = [...canonicalMessages, latestUserMessage];
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

    const wantsStream = isRecord(body) && body.stream === true;
    if (wantsStream) {
      streaming = true;
      const stream = new ReadableStream<Uint8Array>({
        cancel() { disconnect.abort(); },
        async start(controller) {
          let sentDone = false;

          try {
            for await (const chunk of generateChatReplyStream(promptMessages, {
              primaryModel: selectedPrimaryModel,
              signal: operationSignal,
              enableWebSearch,
              enableUrlReader: enableWebSearch,
              enableHttpFetch: enableWebSearch,
              contractsUserId: userId,
              enableImageGeneration: modelSnapshot.imageGenerationAvailable,
              userId,
            })) {
              if (req.signal.aborted || disconnect.signal.aborted) {
                return;
              }

              if (chunk.type === "delta") {
                controller.enqueue(
                  streamEvent({ type: "delta", text: chunk.text }),
                );
                continue;
              }

              if (chunk.type === "tool") {
                controller.enqueue(streamEvent(chunk));
                continue;
              }

              const assistantMessage = appendWebSourcesToMessage(
                chunk.reply.message,
                chunk.reply.webSearch?.sources ?? [],
              );

              // The full answer has already been streamed to (and rendered by) the client, so a
              // persistence failure here must NOT flip the visible message to an error state.
              // Log it, mark the done event as unpersisted, and still finalize the turn.
              let persisted = true;
              try {
                storedMessages = await persistChatMessages({
                  userId,
                  threadId,
                  latestUserMessage,
                  assistantMessage,
                  agentMessages: chunk.reply.agentMessages,
                  webSources: chunk.reply.webSearch?.sources,
                  toolActivity: chunk.reply.toolActivity,
                  assistantModel: chunk.reply.model ?? null,
                  assistantProvider: chunk.reply.provider ?? null,
                  temporary: isTemporaryChat,
                });
              } catch (persistError) {
                if (req.signal.aborted || disconnect.signal.aborted || isAbortError(persistError)) {
                  return;
                }
                persisted = false;
                console.error("Chat persist (stream) failed:", persistError);
              }

              controller.enqueue(
                streamEvent(
                  toDoneStreamEvent({
                    reply: chunk.reply,
                    message: assistantMessage,
                    temporary: isTemporaryChat,
                    persisted,
                    storedMessages,
                  }),
                ),
              );
              sentDone = true;
            }

            if (!sentDone && !req.signal.aborted && !disconnect.signal.aborted) {
              controller.enqueue(
                streamEvent({
                  type: "error",
                  error: "Chat stream ended before completion.",
                }),
              );
            }
          } catch (streamError) {
            if (req.signal.aborted || disconnect.signal.aborted || isAbortError(streamError)) {
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
            await release?.().catch((error) => console.error("Chat lease release failed", error));
            if (!disconnect.signal.aborted) controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const { message, provider, model, webSearch, agentMessages, toolActivity } = await generateChatReply(
      promptMessages,
      {
        primaryModel: selectedPrimaryModel,
        signal: operationSignal,
        enableWebSearch,
        enableUrlReader: enableWebSearch,
        enableHttpFetch: enableWebSearch,
        contractsUserId: userId,
        enableImageGeneration: modelSnapshot.imageGenerationAvailable,
        userId,
      },
    );
    const assistantMessage = appendWebSourcesToMessage(
      message,
      webSearch?.sources ?? [],
    );

    let persisted = true;
    if (!isTemporaryChat) {
      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        storedMessages = await persistChatMessages({
          userId,
          threadId,
          latestUserMessage,
          assistantMessage,
          agentMessages,
          webSources: webSearch?.sources,
          toolActivity,
          assistantModel: model ?? null,
          assistantProvider: provider ?? null,
          temporary: false,
        });
      } catch (persistError) {
        // Match the streaming path: inference already succeeded, so keep the useful reply while
        // clearly telling the client not to treat the in-memory turn as canonical history.
        persisted = false;
        console.error("Chat persist (non-stream) failed:", persistError);
      }
    }

    return NextResponse.json({
      message: assistantMessage,
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
    });
  } catch (error: unknown) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: getPublicChatErrorMessage(error) },
      { status: 500 },
    );
  } finally {
    if (!streaming) await release?.().catch((error) => console.error("Chat lease release failed", error));
  }
}