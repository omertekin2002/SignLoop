import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import {
  generateChatReply,
  generateChatReplyStream,
  type ChatMessage,
  type ChatReply,
  type ChatRole,
} from '@/lib/chat';
import {
  DEFAULT_PERSONALITY_MODE,
  isAllowedPersonalityMode,
} from '@/lib/personality-settings';
import {
  appendChatMessagesToThread,
  getUserSettingsByUserId,
} from '@/lib/server-db';

const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 4000;

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

type RequestPayload = {
  threadId?: unknown;
  messages?: unknown;
  temporary?: unknown;
  stream?: unknown;
};

type SearchSource = {
  title: string;
  url: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatRole(value: unknown): value is ChatRole {
  return value === "system" || value === "user" || value === "assistant";
}

function parseChatMessages(payload: unknown): ChatMessage[] {
  if (!isObject(payload)) {
    return [];
  }

  const candidate = payload as RequestPayload;
  const rawMessages = candidate.messages;
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const normalized: ChatMessage[] = [];

  for (const item of rawMessages) {
    if (!isObject(item)) continue;

    const role = item.role;
    const content = item.content;
    if (!isChatRole(role) || typeof content !== "string") continue;

    const trimmed = content.trim();
    if (!trimmed) continue;

    normalized.push({
      role,
      content: trimmed.slice(0, MAX_MESSAGE_LENGTH),
    });
  }

  return normalized.slice(-MAX_MESSAGES);
}

function appendWebSourcesToMessage(
  message: string,
  sources: readonly SearchSource[]
): string {
  if (!sources.length) {
    return message;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return message;
  }

  const allUrlsAlreadyPresent = sources.every((source) => trimmed.includes(source.url));
  if (allUrlsAlreadyPresent) {
    return message;
  }

  const lines: string[] = ["Sources:"];
  for (const [index, source] of sources.entries()) {
    lines.push(`${index + 1}. [${source.title}](${source.url})`);
  }

  return `${trimmed}\n\n${lines.join("\n")}`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
}

function streamEvent(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

async function persistChatMessages(input: {
  userId: string | null;
  threadId: string;
  latestUserMessage: ChatMessage;
  assistantMessage: string;
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
      { role: "assistant", content: input.assistantMessage },
    ],
  });
}

function toDoneStreamEvent(input: {
  reply: ChatReply;
  message: string;
  temporary: boolean;
}): Record<string, unknown> {
  const { reply, message, temporary } = input;

  return {
    type: "done",
    message,
    provider: reply.provider,
    model: reply.model,
    mode: temporary ? "temporary-chat" : "chat",
    webSearchQuery: reply.webSearch?.query ?? null,
    webSearchAttempts: reply.webSearch?.attemptedQueries ?? [],
    webSearchSuccessfulCount: reply.webSearch?.successfulSearches ?? 0,
    webSources: reply.webSearch?.sources ?? [],
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const isTemporaryChat = isObject(body) && body.temporary === true;
    const { userId } = await auth();

    if (!userId && !isTemporaryChat) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const threadId =
      isObject(body) && typeof body.threadId === "string" ? body.threadId.trim() : "";

    if (!isTemporaryChat && !threadId) {
      return NextResponse.json({ error: "threadId is required." }, { status: 400 });
    }

    const parsedMessages = parseChatMessages(body);
    const conversationMessages = parsedMessages.filter((message) => message.role !== "system");

    const latestUserMessage = [...conversationMessages]
      .reverse()
      .find((message) => message.role === "user");
    if (!latestUserMessage) {
      return NextResponse.json(
        { error: "Chat requires at least one user message." },
        { status: 400 }
      );
    }

    const settings = userId ? await getUserSettingsByUserId(userId) : null;
    const personality =
      settings?.personality && isAllowedPersonalityMode(settings.personality)
        ? settings.personality
        : DEFAULT_PERSONALITY_MODE;
    const promptMessages: ChatMessage[] =
      personality === "bare-llm"
        ? [{ role: "system", content: BARE_LLM_SYSTEM_PROMPT }, ...conversationMessages]
        : [{ role: "system", content: CHAT_SYSTEM_PROMPT }, ...conversationMessages];

    const wantsStream = isObject(body) && body.stream === true;
    if (wantsStream) {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let sentDone = false;

          try {
            for await (const chunk of generateChatReplyStream(promptMessages, {
              primaryModel: settings?.primaryModel ?? null,
              signal: req.signal,
            })) {
              if (req.signal.aborted) {
                return;
              }

              if (chunk.type === "delta") {
                controller.enqueue(streamEvent({ type: "delta", text: chunk.text }));
                continue;
              }

              const assistantMessage = appendWebSourcesToMessage(
                chunk.reply.message,
                chunk.reply.webSearch?.sources ?? []
              );

              await persistChatMessages({
                userId,
                threadId,
                latestUserMessage,
                assistantMessage,
                temporary: isTemporaryChat,
              });

              controller.enqueue(
                streamEvent(
                  toDoneStreamEvent({
                    reply: chunk.reply,
                    message: assistantMessage,
                    temporary: isTemporaryChat,
                  })
                )
              );
              sentDone = true;
            }

            if (!sentDone && !req.signal.aborted) {
              controller.enqueue(
                streamEvent({
                  type: "error",
                  error: "Chat stream ended before completion.",
                })
              );
            }
          } catch (streamError) {
            if (req.signal.aborted || isAbortError(streamError)) {
              return;
            }

            console.error("Chat stream error:", streamError);
            const message =
              streamError instanceof Error ? streamError.message : "Chat request failed";
            controller.enqueue(streamEvent({ type: "error", error: message }));
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
      { primaryModel: settings?.primaryModel ?? null, signal: req.signal }
    );
    const assistantMessage = appendWebSourcesToMessage(
      message,
      webSearch?.sources ?? []
    );

    if (!isTemporaryChat) {
      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        await appendChatMessagesToThread({
          userId,
          threadId,
          messages: [
            { role: "user", content: latestUserMessage.content },
            { role: "assistant", content: assistantMessage },
          ],
        });
      } catch (persistError) {
        const persistMessage =
          persistError instanceof Error ? persistError.message : "Failed to persist chat";
        const status = persistMessage.includes("not found") ? 404 : 500;
        return NextResponse.json({ error: persistMessage }, { status });
      }
    }

    return NextResponse.json({
      message: assistantMessage,
      provider,
      model,
      mode: isTemporaryChat ? "temporary-chat" : "chat",
      webSearchQuery: webSearch?.query ?? null,
      webSearchAttempts: webSearch?.attemptedQueries ?? [],
      webSearchSuccessfulCount: webSearch?.successfulSearches ?? 0,
      webSources: webSearch?.sources ?? [],
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Chat request failed";
    console.error("Chat API error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
