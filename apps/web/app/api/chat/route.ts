import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  generateChatReply,
  generateChatReplyStream,
  type ChatMessage,
  type ChatReply,
} from "@/lib/chat";
import { GeminiWebSearchError } from "@/lib/gemini-search";
import {
  boundCanonicalChatHistory,
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

function getPublicChatErrorMessage(error: unknown): string {
  return error instanceof GeminiWebSearchError
    ? error.publicMessage
    : DEFAULT_CHAT_ERROR_MESSAGE;
}

type SearchSource = {
  title: string;
  url: string;
};

function appendWebSourcesToMessage(
  message: string,
  sources: readonly SearchSource[],
): string {
  if (!sources.length) {
    return message;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return message;
  }

  // Consider a URL already cited only when it appears followed by a non-URL character (or the end
  // of the text), so a short URL isn't treated as "present" just because it is a prefix of a
  // longer one in the prose. Then list only the sources that aren't already cited.
  const isAlreadyCited = (url: string): boolean => {
    let from = 0;
    for (;;) {
      const idx = trimmed.indexOf(url, from);
      if (idx === -1) return false;
      const next = trimmed.charAt(idx + url.length);
      if (next === "" || !/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/.test(next)) {
        return true;
      }
      from = idx + url.length;
    }
  };

  const missingSources = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => !isAlreadyCited(source.url));
  if (!missingSources.length) {
    return message;
  }

  const lines: string[] = ["Sources:"];
  for (const { source, index } of missingSources) {
    lines.push(`${index + 1}. [${source.title}](<${source.url}>)`);
  }

  return `${trimmed}\n\n${lines.join("\n")}`;
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
  temporary: boolean;
}): Promise<void> {
  if (input.temporary) {
    return;
  }

  if (!input.userId) {
    throw new Error("Unauthorized");
  }

  await appendChatMessagesToThread({
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
        },
      },
    ],
  });
}

function toDoneStreamEvent(input: {
  reply: ChatReply;
  message: string;
  temporary: boolean;
  persisted?: boolean;
}): Record<string, unknown> {
  const { reply, message, temporary, persisted = true } = input;

  return {
    type: "done",
    message,
    provider: reply.provider,
    model: reply.model,
    mode: temporary ? "temporary-chat" : "chat",
    persisted: temporary ? undefined : persisted,
    webSearchQuery: reply.webSearch?.query ?? null,
    webSearchAttempts: reply.webSearch?.attemptedQueries ?? [],
    webSearchSuccessfulCount: reply.webSearch?.successfulSearches ?? 0,
    webSources: reply.webSearch?.sources ?? [],
  };
}

export async function POST(req: Request) {
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
    // Search is a server-side invariant for authenticated chats, so clients cannot disable it.
    // Anonymous temporary chats stay unsearched to protect the private Gemini quota.
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

    const [settings, persistedMessages, modelSnapshot] = await Promise.all([
      userId ? getUserSettingsByUserId(userId) : Promise.resolve(null),
      userId && !isTemporaryChat
        ? getRecentChatMessagesForThreadForUser(
            userId,
            threadId,
            MAX_CHAT_MESSAGES - 1,
          )
        : Promise.resolve([]),
      userId
        ? getModelAvailabilitySnapshot({ forceRefresh: true })
        : Promise.resolve({ availablePrimaryModels: [] }),
    ]);

    const selectedPrimaryModel = userId
      ? resolveAvailablePrimaryModel(
          settings?.primaryModel,
          modelSnapshot.availablePrimaryModels,
        )
      : null;

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
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let sentDone = false;

          try {
            for await (const chunk of generateChatReplyStream(promptMessages, {
              primaryModel: selectedPrimaryModel,
              signal: req.signal,
              enableWebSearch,
            })) {
              if (req.signal.aborted) {
                return;
              }

              if (chunk.type === "delta") {
                controller.enqueue(
                  streamEvent({ type: "delta", text: chunk.text }),
                );
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
                await persistChatMessages({
                  userId,
                  threadId,
                  latestUserMessage,
                  assistantMessage,
                  assistantModel: chunk.reply.model ?? null,
                  assistantProvider: chunk.reply.provider ?? null,
                  temporary: isTemporaryChat,
                });
              } catch (persistError) {
                if (req.signal.aborted || isAbortError(persistError)) {
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
                  }),
                ),
              );
              sentDone = true;
            }

            if (!sentDone && !req.signal.aborted) {
              controller.enqueue(
                streamEvent({
                  type: "error",
                  error: "Chat stream ended before completion.",
                }),
              );
            }
          } catch (streamError) {
            if (req.signal.aborted || isAbortError(streamError)) {
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
            controller.close();
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

    const { message, provider, model, webSearch } = await generateChatReply(
      promptMessages,
      {
        primaryModel: selectedPrimaryModel,
        signal: req.signal,
        enableWebSearch,
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
        await persistChatMessages({
          userId,
          threadId,
          latestUserMessage,
          assistantMessage,
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
      provider,
      model,
      mode: isTemporaryChat ? "temporary-chat" : "chat",
      persisted: isTemporaryChat ? undefined : persisted,
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
  }
}
