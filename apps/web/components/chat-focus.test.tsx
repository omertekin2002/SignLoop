import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatThreadFocus,
  ChatThreadMessage,
} from "@/lib/workspace-query-options";

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
vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import { ChatPanel, contractChatDraft } from "@/components/chat-panel";

const threadId = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const contractId = "33333333-3333-4333-8333-333333333333";
const at = "2026-11-22T00:00:00.000Z";
const message = (
  id: string,
  position: number,
  role: "user" | "assistant",
  content: string,
): ChatThreadMessage => ({ id, position, role, content, createdAt: at });

let threadMessages: ChatThreadMessage[];
let threadFocus: ChatThreadFocus | null;
let requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
/** Extra fields of the done event the chat API answers with. */
let doneExtra: Record<string, unknown>;

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  requests = [];
  threadMessages = [];
  threadFocus = null;
  doneExtra = {};
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
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      if (url === "/api/chat/threads" && method === "POST")
        return respond({ data: { id: threadId } }, 201);
      if (url === `/api/chat/threads/${threadId}`)
        return respond({
          data: { id: threadId, title: "Lease", hasMore: false, messages: threadMessages, focus: threadFocus },
        });
      if (url === "/api/chat" && method === "POST") {
        const stored = [
          message("q", threadMessages.length + 1, "user", "question"),
          message("a", threadMessages.length + 2, "assistant", "Clause 9 allows it."),
        ];
        return new Response(
          `${JSON.stringify({
            type: "done",
            message: "Clause 9 allows it.",
            storedMessages: stored,
            persisted: true,
            mode: "chat",
            ...doneExtra,
          })}\n`,
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type PanelProps = Parameters<typeof ChatPanel>[0];

/** Selects the thread a first message creates, as the dashboard does. */
function Host(props: PanelProps) {
  const [selected, setSelected] = useState(props.selectedThreadId ?? null);
  return (
    <ChatPanel
      {...props}
      selectedThreadId={selected}
      onThreadSelected={setSelected}
    />
  );
}

function renderPanel(props: PanelProps) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Host {...props} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderPanel: (next: PanelProps) =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <Host {...next} />
        </QueryClientProvider>,
      ),
  };
}

// Await findByText without asserting on the element it returns: a reply first renders as plain
// text and is replaced once the lazily loaded Markdown renderer arrives, detaching that element.
const composer = () => screen.getByRole("textbox", { name: "Chat message" });
const chatPosts = () => requests.filter((request) => request.url === "/api/chat");

describe("a new saved chat about a contract", () => {
  it("shows the contract and an editable draft, and sends nothing until the user presses Send", async () => {
    renderPanel({ focusContract: { contractId, title: "Office lease" } });

    await waitFor(() => expect(composer()).toHaveValue(contractChatDraft("Office lease")));
    expect(contractChatDraft("Office lease")).toBe("About “Office lease”: ");
    const link = screen.getByRole("link", { name: "Office lease" });
    expect(link).toHaveAttribute("href", `/contracts/${contractId}`);
    expect(link.parentElement).toHaveTextContent("About: Office lease");
    // No thread and no chat request exist yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toEqual([]);

    const user = userEvent.setup();
    await user.type(composer(), "can I end it early?");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(chatPosts()).toHaveLength(1));
    expect(requests[0]).toMatchObject({ url: "/api/chat/threads", method: "POST" });
    expect(chatPosts()[0]!.body).toMatchObject({
      threadId,
      focusContractId: contractId,
      messages: [{ role: "user", content: "About “Office lease”: can I end it early?" }],
    });
    // The new thread keeps the scope line.
    await screen.findByText("Clause 9 allows it.");
    expect(screen.getByRole("link", { name: "Office lease" })).toBeInTheDocument();
  });

  it("leaves a draft the user already started alone", async () => {
    const view = renderPanel({ focusContract: { contractId } });
    await waitFor(() => expect(composer()).toBeEnabled());
    const user = userEvent.setup();
    await user.type(composer(), "My own words");
    view.rerenderPanel({ focusContract: { contractId, title: "Office lease" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(composer()).toHaveValue("My own words");
  });

  it("says when the contract is not available, and sends an ordinary chat without a draft", async () => {
    renderPanel({ focusContract: { contractId, title: null } });

    await screen.findByText("This contract is not available, so this chat will not be about it.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(composer()).toHaveValue("");

    const user = userEvent.setup();
    await user.type(composer(), "Hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(chatPosts()).toHaveLength(1));
    expect(chatPosts()[0]!.body).not.toHaveProperty("focusContractId");
    await screen.findByText("Clause 9 allows it.");
  });

  it("starts with an item's draft once it is built, and sends it only when the user presses Send", async () => {
    const itemDraft =
      "About “Office lease”: Explain the finding “Auto-renewal trap”: which clause it relies on, and what I should clarify before signing. Quote the clause, or say none was found.";
    // While the draft is still being built, the composer waits instead of taking the plain draft.
    const view = renderPanel({
      focusContract: { contractId, title: "Office lease" },
      focusDraft: null,
    });
    await waitFor(() => expect(composer()).toBeEnabled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(composer()).toHaveValue("");

    view.rerenderPanel({
      focusContract: { contractId, title: "Office lease" },
      focusDraft: itemDraft,
    });
    await waitFor(() => expect(composer()).toHaveValue(itemDraft));
    expect(screen.getByRole("link", { name: "Office lease" }).parentElement).toHaveTextContent(
      "About: Office lease",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toEqual([]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(chatPosts()).toHaveLength(1));
    expect(chatPosts()[0]!.body).toMatchObject({
      threadId,
      focusContractId: contractId,
      messages: [{ role: "user", content: itemDraft }],
    });
    await screen.findByText("Clause 9 allows it.");
  });

  it("never applies an item's draft to temporary chat", async () => {
    renderPanel({
      temporary: true,
      focusContract: { contractId, title: "Office lease" },
      focusDraft: "About “Office lease”: Ask question 1",
    });
    await waitFor(() => expect(composer()).toBeEnabled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(composer()).toHaveValue("");
  });

  it("never applies a focus to temporary chat", async () => {
    renderPanel({ temporary: true, focusContract: { contractId, title: "Office lease" } });

    await waitFor(() => expect(composer()).toBeEnabled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(composer()).toHaveValue("");
    expect(screen.queryByText("About:")).not.toBeInTheDocument();
  });
});

describe("a reloaded saved chat about a contract", () => {
  it("shows its scope from the thread and keeps sending its focus on follow-ups", async () => {
    threadMessages = [
      message("q1", 1, "user", "What is the notice period?"),
      message("a1", 2, "assistant", "Sixty days."),
    ];
    threadFocus = { contractId, title: "Office lease" };
    renderPanel({ selectedThreadId: threadId });

    await screen.findByText("Sixty days.");
    expect(screen.getByRole("link", { name: "Office lease" })).toHaveAttribute(
      "href",
      `/contracts/${contractId}`,
    );
    // A reloaded thread gets no draft.
    expect(composer()).toHaveValue("");

    const user = userEvent.setup();
    await user.type(composer(), "And the deposit?");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(chatPosts()).toHaveLength(1));
    expect(chatPosts()[0]!.body).toMatchObject({ threadId, focusContractId: contractId });
    await screen.findByText("Clause 9 allows it.");
    // The saved turn updates the cached thread without dropping what it is about.
    expect(screen.getByRole("link", { name: "Office lease" })).toBeInTheDocument();
  });

  it("still opens once the contract is deleted, says so, and sends new turns unfocused", async () => {
    threadMessages = [
      message("q1", 1, "user", "What is the notice period?"),
      message("a1", 2, "assistant", "Sixty days."),
    ];
    threadFocus = { contractId, title: null };
    renderPanel({ selectedThreadId: threadId });

    await screen.findByText("Sixty days.");
    expect(
      screen.getByText(
        "The contract this chat was about is no longer available. New messages are not about it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /lease/i })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(composer(), "Anything else?");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(chatPosts()).toHaveLength(1));
    expect(chatPosts()[0]!.body).not.toHaveProperty("focusContractId");
    await screen.findByText("Clause 9 allows it.");
  });

  it("shows no scope line for an ordinary chat", async () => {
    threadMessages = [message("q1", 1, "user", "Hello"), message("a1", 2, "assistant", "Hi.")];
    renderPanel({ selectedThreadId: threadId });

    await screen.findByText("Hi.");
    expect(screen.queryByText("About:")).not.toBeInTheDocument();
  });
});

describe("quotation checks under a reply about a contract", () => {
  const quoteChecks = {
    contractId,
    revision: `sha256:${"b".repeat(64)}`,
    checks: [
      { quote: "Either party may end this lease on sixty days' notice", status: "found" },
      { quote: `The Tenant may leave at any time ${"and more ".repeat(30)}`, status: "not_found" },
    ],
  };

  function expectQuotationRows() {
    const list = screen.getByRole("list", { name: "Quotations" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Either party may end this lease on sixty days' notice");
    expect(rows[0]).toHaveTextContent("Found in the contract");
    expect(rows[1]).toHaveTextContent(
      "Not found in the contract: check the wording against the original",
    );
    // A long quotation is shortened in its row.
    expect(rows[1]!.querySelector("q")!.textContent!.endsWith("…")).toBe(true);
    expect(Array.from(rows[1]!.querySelector("q")!.textContent!).length).toBeLessThanOrEqual(160);
  }

  it("lists each stored check under its reply after a reload, and nothing under a reply without checks", async () => {
    threadMessages = [
      message("q1", 1, "user", "What is the notice period?"),
      { ...message("a1", 2, "assistant", "Sixty days."), quoteChecks } as ChatThreadMessage,
      message("q2", 3, "user", "Thanks"),
      message("a2", 4, "assistant", "You are welcome."),
    ];
    threadFocus = { contractId, title: "Office lease" };
    renderPanel({ selectedThreadId: threadId });

    await screen.findByText("You are welcome.");
    expectQuotationRows();
  });

  it("lists the checks a finished reply's done event carries", async () => {
    doneExtra = { quoteChecks };
    renderPanel({ focusContract: { contractId, title: "Office lease" } });
    await waitFor(() => expect(composer()).toHaveValue(contractChatDraft("Office lease")));

    const user = userEvent.setup();
    await user.type(composer(), "can I end it early?");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await screen.findByText("Clause 9 allows it.");
    await waitFor(() => expect(screen.getByRole("list", { name: "Quotations" })).toBeInTheDocument());
    expectQuotationRows();
  });

  it("shows no list for a reply whose done event has no checks", async () => {
    renderPanel({ focusContract: { contractId, title: "Office lease" } });
    await waitFor(() => expect(composer()).toHaveValue(contractChatDraft("Office lease")));

    const user = userEvent.setup();
    await user.type(composer(), "hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await screen.findByText("Clause 9 allows it.");
    expect(screen.queryByRole("list", { name: "Quotations" })).not.toBeInTheDocument();
  });
});
