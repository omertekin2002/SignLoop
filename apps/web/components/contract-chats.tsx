"use client";

import { useId } from "react";
import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import { useWorkspaceList } from "@/lib/use-workspace-list";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ContractChat = {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
};

/** The first page is short: a contract page lists a few recent chats, and "Show more" pages on. */
export const CONTRACT_CHATS_PAGE_SIZE = 10;

const LOAD_ERROR = "Your chats about this contract could not be loaded.";

function messageCountLabel(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"}`;
}

/**
 * The saved chats about one contract, newest activity first. A chat belongs to the contract its
 * earliest focused question named (`GET /api/chat/threads?contract=`), the same rule that restores
 * its "About" line. Each row reopens the chat in the dashboard by id. The list shares the
 * `chat-threads` query prefix, so a chat sent or deleted in the dashboard refreshes it too.
 * `canAsk` says whether the page offers "Ask about this contract" (the contract has text).
 */
export function ContractChats({
  contractId,
  canAsk,
}: {
  contractId: string;
  canAsk: boolean;
}) {
  const titleId = useId();
  const list = useWorkspaceList<ContractChat>(
    "chat-threads",
    "/chat/threads",
    Boolean(contractId),
    "",
    { contract: contractId },
    CONTRACT_CHATS_PAGE_SIZE,
  );
  const chats = list.data;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId} className="flex items-center gap-2">
          <MessagesSquare className="h-5 w-5" aria-hidden="true" />
          Chats about this contract
        </CardTitle>
        <CardDescription>
          Saved chats you started about this contract, most recent first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {list.isLoadingError ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">{LOAD_ERROR}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void list.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : !chats ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : chats.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No chats about this contract yet.
            {canAsk ? " Start one with Ask about this contract." : null}
          </p>
        ) : (
          <div className="space-y-3">
            <ul className="space-y-3">
              {chats.map((chat) => (
                <li key={chat.id}>
                  <Link
                    href={`/dashboard?thread=${encodeURIComponent(chat.id)}`}
                    className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-input hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {chat.title.trim() || "New chat"}
                    </span>
                    <span className="shrink-0 text-caption text-muted-foreground">
                      Last active{" "}
                      <time dateTime={chat.updatedAt}>
                        {formatDate(chat.updatedAt, "MMM d, HH:mm")}
                      </time>
                      {" · "}
                      {messageCountLabel(chat.messageCount)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {list.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? "Loading…" : "Show more"}
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
