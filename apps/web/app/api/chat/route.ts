import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { generateChatReply, type ChatMessage, type ChatRole } from '@/lib/chat';
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

type RequestPayload = {
  threadId?: unknown;
  messages?: unknown;
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

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const threadId =
      isObject(body) && typeof body.threadId === "string" ? body.threadId.trim() : "";
    if (!threadId) {
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

    const settings = await getUserSettingsByUserId(userId);
    const personality =
      settings?.personality && isAllowedPersonalityMode(settings.personality)
        ? settings.personality
        : DEFAULT_PERSONALITY_MODE;
    const promptMessages: ChatMessage[] =
      personality === "bare-llm"
        ? conversationMessages
        : [{ role: "system", content: CHAT_SYSTEM_PROMPT }, ...conversationMessages];

    const { message, provider, model } = await generateChatReply(
      promptMessages,
      { primaryModel: settings?.primaryModel ?? null }
    );

    try {
      await appendChatMessagesToThread({
        userId,
        threadId,
        messages: [
          { role: "user", content: latestUserMessage.content },
          { role: "assistant", content: message },
        ],
      });
    } catch (persistError) {
      const persistMessage =
        persistError instanceof Error ? persistError.message : "Failed to persist chat";
      const status = persistMessage.includes("not found") ? 404 : 500;
      return NextResponse.json({ error: persistMessage }, { status });
    }

    return NextResponse.json({
      message,
      provider,
      model,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Chat request failed";
    console.error("Chat API error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
