'use client';

import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import { MessageSquareText, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ChatApiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatApiSuccess = {
  message: string;
  provider?: string;
  model?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractMessageText(message: ThreadMessage): string {
  const chunks: string[] = [];

  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text.trim()) {
        chunks.push(part.text.trim());
      }
      continue;
    }

    if (part.type === "source") {
      const sourceLabel = part.title ? `${part.title}: ${part.url}` : part.url;
      chunks.push(sourceLabel);
      continue;
    }

    if (part.type === "image") {
      chunks.push(part.filename ? `[image: ${part.filename}]` : "[image]");
      continue;
    }

    if (part.type === "file") {
      chunks.push(part.filename ? `[file: ${part.filename}]` : "[file]");
      continue;
    }

    if (part.type === "audio") {
      chunks.push("[audio]");
      continue;
    }

    if (part.type === "tool-call") {
      chunks.push(`[tool-call: ${part.toolName}]`);
      continue;
    }

    if (part.type === "data") {
      chunks.push(`[data: ${part.name}]`);
    }
  }

  return chunks.join("\n").trim();
}

function toApiMessages(messages: readonly ThreadMessage[]): ChatApiMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: extractMessageText(message),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-30);
}

function parseError(payload: unknown, status: number): string {
  if (isRecord(payload) && typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }

  return `Chat request failed (${status})`;
}

function parseSuccess(payload: unknown): ChatApiSuccess {
  if (!isRecord(payload) || typeof payload.message !== "string") {
    throw new Error("Chat response did not include a message.");
  }

  const message = payload.message.trim();
  if (!message) {
    throw new Error("Chat response was empty.");
  }

  return {
    message,
    provider: typeof payload.provider === "string" ? payload.provider : undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
  };
}

const UserTextPart = () => (
  <MessagePartPrimitive.Text component="p" className="whitespace-pre-wrap text-sm leading-6 text-primary-foreground" />
);

const AssistantTextPart = () => (
  <MessagePartPrimitive.Text component="p" className="whitespace-pre-wrap text-sm leading-6 text-foreground" />
);

const ChatMessage = () => {
  return (
    <MessagePrimitive.Root className="mb-4">
      <MessagePrimitive.If user>
        <div className="ml-auto max-w-3xl border border-border bg-primary px-4 py-3 shadow-sm">
          <MessagePrimitive.Content components={{ Text: UserTextPart }} />
        </div>
      </MessagePrimitive.If>

      <MessagePrimitive.If assistant>
        <div className="mr-auto max-w-3xl border border-border bg-card/90 px-4 py-3 shadow-sm backdrop-blur-sm">
          <MessagePrimitive.Content
            components={{
              Text: AssistantTextPart,
              Reasoning: AssistantTextPart,
            }}
          />
          <MessagePrimitive.Error>
            <p className="mt-2 text-xs text-destructive">Failed to generate a response. Please try again.</p>
          </MessagePrimitive.Error>
        </div>
      </MessagePrimitive.If>

      <MessagePrimitive.If system>
        <div className="mx-auto max-w-2xl text-center text-xs text-muted-foreground">
          <MessagePrimitive.Content components={{ Text: AssistantTextPart }} />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
};

export function ChatPanel() {
  const chatModel = useMemo<ChatModelAdapter>(
    () => ({
      run: async ({ messages, abortSignal }) => {
        const payloadMessages = toApiMessages(messages);

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages: payloadMessages }),
          signal: abortSignal,
        });

        const rawPayload = await response.text();
        let parsedPayload: unknown = null;

        if (rawPayload) {
          try {
            parsedPayload = JSON.parse(rawPayload);
          } catch {
            parsedPayload = null;
          }
        }

        if (!response.ok) {
          throw new Error(parseError(parsedPayload, response.status));
        }

        const parsedSuccess = parseSuccess(parsedPayload);
        return {
          content: [{ type: "text", text: parsedSuccess.message }] as const,
          metadata: {
            custom: {
              provider: parsedSuccess.provider ?? null,
              model: parsedSuccess.model ?? null,
            },
          },
        };
      },
    }),
    []
  );

  const runtime = useLocalRuntime(chatModel);

  return (
    <Card className="border border-border bg-card/80 shadow-sm backdrop-blur-sm">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-xl">Chat Assistant</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root className="flex h-[68vh] flex-col">
            <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto p-4">
              <ThreadPrimitive.Empty>
                <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center text-muted-foreground">
                  <MessageSquareText className="h-8 w-8" />
                  <p className="text-sm">
                    Ask about clauses, obligations, dates, or negotiation points. The assistant uses your current
                    model settings and OpenRouter fallback chain.
                  </p>
                </div>
              </ThreadPrimitive.Empty>

              <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
            </ThreadPrimitive.Viewport>

            <ComposerPrimitive.Root className="border-t border-border bg-background/70 p-3">
              <div className="flex items-end gap-2">
                <ComposerPrimitive.Input
                  className={cn(
                    "min-h-[52px] w-full resize-none border border-input bg-card px-3 py-2 text-sm text-foreground outline-none ring-0",
                    "placeholder:text-muted-foreground focus-visible:border-ring"
                  )}
                  placeholder="Type your question..."
                  submitMode="enter"
                  rows={1}
                />

                <ThreadPrimitive.If running={false}>
                  <ComposerPrimitive.Send asChild>
                    <Button type="button" size="icon" className="h-11 w-11 shrink-0">
                      <Send className="h-4 w-4" />
                    </Button>
                  </ComposerPrimitive.Send>
                </ThreadPrimitive.If>

                <ThreadPrimitive.If running>
                  <ComposerPrimitive.Cancel asChild>
                    <Button type="button" variant="outline" size="icon" className="h-11 w-11 shrink-0">
                      <Square className="h-4 w-4" />
                    </Button>
                  </ComposerPrimitive.Cancel>
                </ThreadPrimitive.If>
              </div>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </CardContent>
    </Card>
  );
}
