import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadMessage } from "@/lib/workspace-query-options";

vi.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ loading: false, user: { id: "user-1" } }),
}));
vi.mock("@/lib/privacy-consent", () => ({
  PRIVACY_CONSENT_EVENT: "signloop:privacy-consent-change",
  hasPrivacyConsent: () => true,
}));
vi.mock("@/lib/usage-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/usage-client")>()),
  useUsage: () => ({ data: undefined }),
  syncUsage: vi.fn(),
}));
vi.mock("@/lib/use-workspace-list", () => ({
  refreshWorkspaceList: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/components/landing-hero", () => ({ LandingHero: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { ChatPanel } from "@/components/chat-panel";

const threadId = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const turnId = "6f1c2b9e-8d4a-4b7c-9e2f-0a1b2c3d4e5f";
const at = "2026-11-20T00:00:00.000Z";
const message = (
  id: string,
  position: number,
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatThreadMessage> = {},
): ChatThreadMessage => ({ id, position, role, content, createdAt: at, ...extra });

let threadMessages: ChatThreadMessage[];
let chatRequests: Record<string, unknown>[];

function respond(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  chatRequests = [];
  // assistant-ui's viewport measures and scrolls, which jsdom does not implement.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/chat/threads/${threadId}`)
        return respond({
          data: { id: threadId, title: "Lease", hasMore: false, messages: threadMessages },
        });
      if (url === "/api/chat" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        chatRequests.push(body);
        const stored = [
          message("new-question", 3, "user", "Explain my lease renewal.", { turnId }),
          message("new-answer", 4, "assistant", "Renewal extends the term by a year."),
        ];
        return new Response(
          `${JSON.stringify({
            type: "done",
            message: "Renewal extends the term by a year.",
            storedMessages: stored,
            persisted: true,
            mode: "chat",
          })}\n`,
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderThread() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatPanel selectedThreadId={threadId} />
    </QueryClientProvider>,
  );
}

describe("a reloaded thread with an interrupted turn", () => {
  it("shows the partial answer with a marker, and Retry resends the saved turn id", async () => {
    threadMessages = [
      message("question", 1, "user", "Explain my lease renewal.", { turnId }),
      message("partial", 2, "assistant", "Renewal ext", { interrupted: "stopped" }),
    ];
    renderThread();

    await screen.findByText("Renewal ext");
    const notice = (await screen.findByText(/Reply interrupted\./)).closest("[role=status]")!;
    expect(notice).toHaveTextContent("Reply interrupted. Retry for a complete answer.");

    await userEvent.click(within(notice as HTMLElement).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0]).toMatchObject({
      threadId,
      turnId,
      messages: [{ role: "user", content: "Explain my lease renewal." }],
    });
    await screen.findByText("Renewal extends the term by a year.");
    expect(screen.queryByText(/Reply interrupted/)).not.toBeInTheDocument();
    expect(screen.queryByText("Renewal ext")).not.toBeInTheDocument();
  });

  it("shows the question with a marker and Retry, which resends its saved files", async () => {
    const file = {
      id: "abcdef01-2345-4678-9abc-def012345678",
      name: "lease.txt",
      mediaType: "text/plain",
      size: 12,
      url: `/api/chat/threads/${threadId}/files/abcdef01-2345-4678-9abc-def012345678`,
    };
    threadMessages = [
      message("question", 1, "user", "Explain my lease renewal.", {
        turnId,
        interrupted: "error",
        files: [file],
      }),
    ];
    renderThread();

    await screen.findByText("Explain my lease renewal.");
    const notice = (await screen.findByText(/Reply interrupted by an error\./)).closest(
      "[role=status]",
    ) as HTMLElement;
    await userEvent.click(within(notice).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(chatRequests).toHaveLength(1));
    // The saved file is sent by id; no "Reattach the file" error.
    expect(chatRequests[0]).toMatchObject({
      turnId,
      messages: [{ role: "user", fileIds: [file.id] }],
    });
    await screen.findByText("Renewal extends the term by a year.");
  });

  it("marks an older interrupted turn without offering Retry, and leaves finished turns unmarked", async () => {
    threadMessages = [
      message("question", 1, "user", "Explain my lease renewal.", { turnId }),
      message("partial", 2, "assistant", "Renewal ext", { interrupted: "stopped" }),
      message("follow-up", 3, "user", "What about notice periods?"),
      message("answer", 4, "assistant", "Thirty days."),
    ];
    renderThread();

    await screen.findByText("Thirty days.");
    const notices = screen.getAllByText(/Reply interrupted/);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toHaveTextContent(/^Reply interrupted\.$/);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
