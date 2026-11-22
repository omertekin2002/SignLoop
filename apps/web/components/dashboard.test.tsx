import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import Dashboard from "@/components/dashboard";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  chatPanel: vi.fn(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiClient: { get: mocks.get, delete: mocks.delete },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: "user" }, loading: false, signOut: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
// The chat itself is not under test, and its runtime needs a browser; its props are recorded.
vi.mock("@/components/chat-panel", () => ({
  ChatPanel: (props: Record<string, unknown>) => {
    mocks.chatPanel(props);
    return null;
  },
}));

type Row = { id: string; title: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function page(rows: Row[]) {
  return {
    data: {
      data: rows.map((row) => ({
        ...row,
        status: "ANALYZED",
        createdAt: "2026-01-05T10:00:00.000Z",
        updatedAt: "2026-01-05T10:00:00.000Z",
        messageCount: 2,
      })),
      total: rows.length,
      limit: 50,
      offset: 0,
    },
  };
}

const draft = { id: "a", title: "Lease draft" };
const renewal = { id: "b", title: "Lease renewal" };

/**
 * Serves one workspace list and its title search. The first search is held open, as a request
 * sent before a deletion finished and answered after it; later searches see the deletion.
 */
function serveList(listPath: string) {
  const earlierSearch = deferred<ReturnType<typeof page>>();
  const searches: string[] = [];
  let deleted = false;
  mocks.get.mockImplementation(async (url: string) => {
    const { pathname, searchParams } = new URL(url, "https://app.test");
    if (pathname === "/settings")
      return { data: { primaryModel: "model", availablePrimaryModels: ["model"] } };
    if (pathname !== listPath) return page([]);
    if (!searchParams.get("q")) return page(deleted ? [renewal] : [draft, renewal]);
    searches.push(url);
    return searches.length === 1 ? earlierSearch.promise : page([renewal]);
  });
  const deletion = deferred<{ data: null }>();
  mocks.delete.mockImplementation(() => deletion.promise);
  return {
    searches,
    finishDeletion() {
      deleted = true;
      deletion.resolve({ data: null });
    },
    answerEarlierSearch: () => earlierSearch.resolve(page([draft, renewal])),
  };
}

async function openDashboard() {
  const user = userEvent.setup();
  // The app's freshness window: an answer stored as fresh is not requested again for a minute.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  render(
    <QueryClientProvider client={client}>
      <Dashboard />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Open sidebar" }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deleting from the dashboard", () => {
  it("searches chats again when a search sent before a deletion is still unanswered", async () => {
    const list = serveList("/chat/threads");
    const user = await openDashboard();

    await screen.findByText("Lease draft");
    await user.click(screen.getAllByRole("button", { name: "Delete chat" })[0]!);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete Chat",
      }),
    );
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith("/chat/threads/a");

    // The confirmation has closed and the deletion is still running: the sidebar can be searched.
    await user.type(
      await screen.findByRole("searchbox", { name: "Search chats" }),
      "lease",
    );
    expect(await screen.findByText("Searching chats…")).toBeInTheDocument();
    expect(list.searches).toHaveLength(1);

    const rendered: string[] = [];
    const recorder = new MutationObserver(() => {
      rendered.push(document.body.textContent ?? "");
    });
    recorder.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    list.finishDeletion();
    await waitFor(() => expect(list.searches).toHaveLength(2));
    list.answerEarlierSearch();

    expect(await screen.findByText("1 chat matches “lease”")).toBeInTheDocument();
    recorder.disconnect();
    // Restarting the search must not flash its empty state in between.
    expect(rendered.join("\n")).not.toContain("No chats match");
    expect(screen.getByText("Lease renewal")).toBeInTheDocument();
    expect(screen.queryByText("Lease draft")).not.toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("searches contracts again when a search sent before a deletion is still unanswered", async () => {
    const list = serveList("/contracts");
    const user = await openDashboard();
    await user.click(screen.getByRole("button", { name: "Contracts" }));

    await user.click(
      await screen.findByRole("button", { name: "Delete Lease draft" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete Contract",
      }),
    );
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith("/contracts/a");

    await user.type(
      await screen.findByRole("searchbox", { name: "Search contracts" }),
      "lease",
    );
    await waitFor(() => expect(list.searches).toHaveLength(1));

    list.finishDeletion();
    await waitFor(() => expect(list.searches).toHaveLength(2));
    list.answerEarlierSearch();

    expect(
      await screen.findByText("1 contract matches “lease”"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete Lease draft" }),
    ).not.toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});

describe("filtering contracts on the dashboard", () => {
  const filed = { id: "c", title: "Warehouse lease", projectId: "p", projectTitle: "Property" };

  /** Serves the standalone list unfiltered; `answer` decides every filtered or searched request. */
  function serveContracts(answer: (params: URLSearchParams) => Promise<unknown> | unknown) {
    const filtered: URLSearchParams[] = [];
    mocks.get.mockImplementation(async (url: string) => {
      const { pathname, searchParams } = new URL(url, "https://app.test");
      if (pathname === "/settings")
        return { data: { primaryModel: "model", availablePrimaryModels: ["model"] } };
      if (pathname !== "/contracts") return page([]);
      if (!["q", "status", "added"].some((name) => searchParams.has(name)))
        return page([draft, renewal]);
      filtered.push(searchParams);
      return answer(searchParams);
    });
    return filtered;
  }

  async function openContracts() {
    const user = await openDashboard();
    await user.click(screen.getByRole("button", { name: "Contracts" }));
    await screen.findByRole("button", { name: "Delete Lease draft" });
    return user;
  }

  it("filters by status and added date, combines them with a search, and clears back to the standalone list", async () => {
    const filtered = serveContracts(() => page([filed]));
    const user = await openContracts();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "analyzed");
    expect(
      await screen.findByText("1 contract matches the filters: analyzed"),
    ).toBeInTheDocument();
    // A filter spans every contract, so results can come from projects.
    expect(screen.getByText("Warehouse lease")).toBeInTheDocument();
    expect(screen.getByText("Property")).toBeInTheDocument();
    // The open sidebar still lists standalone contracts; the main grid no longer does.
    expect(screen.queryByRole("button", { name: "Delete Lease draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(Object.fromEntries(filtered.at(-1)!)).toEqual({
      standalone: "true",
      status: "analyzed",
      limit: "50",
      offset: "0",
    });

    await user.selectOptions(screen.getByRole("combobox", { name: "Added" }), "30d");
    expect(
      await screen.findByText(
        "1 contract matches the filters: analyzed, added in the last 30 days",
      ),
    ).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search contracts" }), "lease");
    expect(
      await screen.findByText(
        "1 contract matches “lease” and the filters: analyzed, added in the last 30 days",
      ),
    ).toBeInTheDocument();
    expect(Object.fromEntries(filtered.at(-1)!)).toMatchObject({
      q: "lease",
      status: "analyzed",
      added: "30d",
    });

    // Clearing the filters keeps the search; clearing the search then restores the standalone list.
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Added" })).toHaveValue("");
    expect(await screen.findByText("1 contract matches “lease”")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByRole("button", { name: "Delete Lease draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Lease renewal" })).toBeInTheDocument();
    expect(screen.queryByText("Warehouse lease")).not.toBeInTheDocument();
  });

  it("says no contract matches the filters, distinct from an empty workspace, and clears from there", async () => {
    serveContracts(() => page([]));
    const user = await openContracts();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "draft");
    await user.selectOptions(screen.getByRole("combobox", { name: "Added" }), "7d");
    expect(
      await screen.findByRole("heading", {
        name: "No contracts match the filters: not analyzed yet, added in the last 7 days",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No contracts found")).not.toBeInTheDocument();

    const clear = screen.getAllByRole("button", { name: "Clear filters" });
    // One beside the controls, one in the empty state.
    expect(clear).toHaveLength(2);
    await user.click(clear.at(-1)!);
    expect(await screen.findByRole("button", { name: "Delete Lease draft" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Added" })).toHaveValue("");
  });

  it("shows where a search matched: an excerpt with the term highlighted for text, nothing extra for titles", async () => {
    const textHit = {
      id: "t",
      title: "Supplier agreement",
      match: { in: "text", snippet: "…either party may end it on a 60-day Notice period, and the notice…" },
    };
    const titleHit = { id: "h", title: "Notice of renewal", match: { in: "title" } };
    const filtered = serveContracts(() => page([textHit, titleHit]));
    const user = await openContracts();

    const field = screen.getByRole("searchbox", { name: "Search contracts" });
    expect(field).toHaveAttribute("placeholder", "Search titles and contract text, including in projects");
    await user.type(field, "notice");
    expect(await screen.findByText("2 contracts match “notice”")).toBeInTheDocument();
    expect(filtered.at(-1)!.get("q")).toBe("notice");

    const textCard = screen.getByText("Supplier agreement").closest("a")!;
    expect(within(textCard).getByText("Matched in contract text")).toBeInTheDocument();
    const marks = textCard.querySelectorAll("mark");
    expect([...marks].map((mark) => mark.textContent)).toEqual(["Notice", "notice"]);
    expect(marks[0]!.parentElement).toHaveTextContent(
      "…either party may end it on a 60-day Notice period, and the notice…",
    );

    const titleCard = screen.getByText("Notice of renewal").closest("a")!;
    expect(within(titleCard).queryByText("Matched in contract text")).not.toBeInTheDocument();
    expect(titleCard.querySelector("mark")).toBeNull();
    expect(screen.getAllByText("Matched in contract text")).toHaveLength(1);

    // Clearing the search restores the standalone list, whose cards carry no match.
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByRole("button", { name: "Delete Lease draft" })).toBeInTheDocument();
    expect(screen.queryByText("Matched in contract text")).not.toBeInTheDocument();
  });

  it("shows the load-error state, not an empty result, when a filtered load fails", async () => {
    let fail = true;
    const filtered = serveContracts(() => {
      if (fail) throw new Error("network");
      return page([filed]);
    });
    const user = await openContracts();

    await user.selectOptions(screen.getByRole("combobox", { name: "Added" }), "365d");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load contracts");
    expect(screen.queryByText(/No contracts match/)).not.toBeInTheDocument();

    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("1 contract matches the filters: added in the last 12 months"),
    ).toBeInTheDocument();
    expect(filtered.every((params) => params.get("added") === "365d")).toBe(true);
  });
});

describe("opening a chat about a contract", () => {
  const contractId = "33333333-3333-4333-8333-333333333333";

  /** The latest props of the saved chat panel (the temporary one is always rendered too). */
  const savedPanel = () =>
    mocks.chatPanel.mock.calls
      .map(([props]) => props as Record<string, unknown>)
      .filter((props) => !props.temporary)
      .at(-1);

  function serveContract(answer: () => Promise<unknown>) {
    mocks.get.mockImplementation(async (url: string) => {
      const { pathname } = new URL(url, "https://app.test");
      if (pathname === "/settings")
        return { data: { primaryModel: "model", availablePrimaryModels: ["model"] } };
      if (pathname === `/contracts/${contractId}`) return answer();
      // An existing thread must not be opened in place of the new chat.
      if (pathname === "/chat/threads") return page([draft]);
      return page([]);
    });
  }

  function renderFocused() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Dashboard focusContractId={contractId} />
      </QueryClientProvider>,
    );
  }

  it("starts a new saved chat about the contract, with the title read from the user's own contract", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    serveContract(async () => ({ data: { title: "Office lease" } }));
    renderFocused();

    await waitFor(() =>
      expect(savedPanel()?.focusContract).toEqual({ contractId, title: "Office lease" }),
    );
    expect(savedPanel()?.selectedThreadId).toBeNull();
    // Without an item to ask about, the panel builds the plain "About" draft itself.
    expect(savedPanel()?.focusDraft).toBeUndefined();
    expect(mocks.get).toHaveBeenCalledWith(`/contracts/${contractId}`, expect.anything());
    // The id is dropped from the address once read, so a reload does not start another draft.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/dashboard");
    // The thread list loaded, and still the new chat stays selected.
    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/chat\/threads/), expect.anything()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(savedPanel()?.selectedThreadId).toBeNull();
    replaceState.mockRestore();
  });

  it("marks the contract unavailable when it is missing or another user's", async () => {
    serveContract(async () => {
      throw Object.assign(new Error("Not found"), {
        isAxiosError: true,
        response: { status: 404, data: { error: "Contract not found" } },
      });
    });
    renderFocused();

    await waitFor(() =>
      expect(savedPanel()?.focusContract).toEqual({ contractId, title: null }),
    );
  });

  it("drops the focus when the user starts another new chat", async () => {
    serveContract(async () => ({ data: { title: "Office lease" } }));
    renderFocused();
    await waitFor(() => expect(savedPanel()?.focusContract).toMatchObject({ contractId }));

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open sidebar" }));
    await user.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(savedPanel()?.focusContract).toBeNull());
  });
});

describe("asking about one Before you sign item", () => {
  const contractId = "33333333-3333-4333-8333-333333333333";
  const latestId = "44444444-4444-4444-8444-444444444444";
  const olderId = "55555555-5555-4555-8555-555555555555";
  const PREFIX = "About “Office lease”: ";

  const result = (findingType: string) => ({
    summary: {
      payments: { amount: null, frequency: null, fees: [] },
      term: { start: null, end: null, minimum_term: null },
      renewal: { auto_renew: null, renewal_period: null },
      cancellation: { notice_period_days: null, notice_period_text: null, penalties: [] },
    },
    red_flags: [{ type: findingType, severity: 8, explanation: "", where: null, confidence: 80 }],
    next_actions: { questions_to_ask: ["Can I cancel early?"], email_templates: [] },
  });

  const savedPanel = () =>
    mocks.chatPanel.mock.calls
      .map(([props]) => props as Record<string, unknown>)
      .filter((props) => !props.temporary)
      .at(-1);

  function serve(older: () => Promise<unknown> = async () => ({ data: { id: olderId, resultJson: result("Late fee") } })) {
    mocks.get.mockImplementation(async (url: string) => {
      const { pathname } = new URL(url, "https://app.test");
      if (pathname === "/settings")
        return { data: { primaryModel: "model", availablePrimaryModels: ["model"] } };
      if (pathname === `/contracts/${contractId}`)
        return {
          data: {
            title: "Office lease",
            // The detail carries only the latest analysis's result.
            analyses: [
              { id: latestId, resultJson: result("Auto-renewal trap") },
              { id: olderId, resultJson: null },
            ],
          },
        };
      if (pathname === `/contracts/${contractId}/analysis/${olderId}`) return older();
      if (pathname.startsWith(`/contracts/${contractId}/analysis/`))
        throw Object.assign(new Error("Not found"), {
          isAxiosError: true,
          response: { status: 404, data: { error: "Analysis not found" } },
        });
      return page([]);
    });
  }

  function renderAsk(analysisId: string, itemKey: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Dashboard
          focusContractId={contractId}
          focusAsk={{ analysisId, itemKey: itemKey as never }}
        />
      </QueryClientProvider>,
    );
  }

  it("drafts the question from the named analysis's stored item, and clears the URL", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    serve();
    renderAsk(latestId, "finding-1");

    await waitFor(() =>
      expect(savedPanel()?.focusDraft).toBe(
        `${PREFIX}Explain the finding “Auto-renewal trap”: which clause it relies on, and what I should clarify before signing. Quote the clause, or say none was found.`,
      ),
    );
    expect(savedPanel()?.focusContract).toEqual({ contractId, title: "Office lease" });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/dashboard");
    // The latest analysis's result came with the detail; nothing else was read.
    expect(mocks.get).not.toHaveBeenCalledWith(
      expect.stringContaining("/analysis/"),
      expect.anything(),
    );
    replaceState.mockRestore();
  });

  it("reads an older analysis on its own before drafting, and waits meanwhile", async () => {
    let answer!: (value: unknown) => void;
    serve(() => new Promise((resolve) => (answer = resolve)));
    renderAsk(olderId, "question-1");

    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith(
        `/contracts/${contractId}/analysis/${olderId}`,
        expect.anything(),
      ),
    );
    expect(savedPanel()?.focusDraft).toBeNull();
    answer({ data: { id: olderId, resultJson: result("Late fee") } });
    await waitFor(() =>
      expect(savedPanel()?.focusDraft).toBe(
        `${PREFIX}Can I cancel early? Answer from the contract and quote the clause you rely on.`,
      ),
    );
  });

  it("falls back to the plain draft for an unknown analysis or a key that names no item", async () => {
    serve();
    renderAsk("66666666-6666-4666-8666-666666666666", "finding-1");
    await waitFor(() => expect(savedPanel()?.focusDraft).toBe(PREFIX));
  });

  it("falls back to the plain draft when the key no longer resolves (after a re-analysis)", async () => {
    serve();
    renderAsk(latestId, "finding-2");
    await waitFor(() => expect(savedPanel()?.focusDraft).toBe(PREFIX));
  });

  it("falls back to the plain draft for a contract with no analysis", async () => {
    mocks.get.mockImplementation(async (url: string) => {
      const { pathname } = new URL(url, "https://app.test");
      if (pathname === "/settings")
        return { data: { primaryModel: "model", availablePrimaryModels: ["model"] } };
      if (pathname === `/contracts/${contractId}`)
        return { data: { title: "Office lease", analyses: [] } };
      if (pathname.startsWith(`/contracts/${contractId}/analysis/`))
        throw Object.assign(new Error("Not found"), {
          isAxiosError: true,
          response: { status: 404, data: { error: "Analysis not found" } },
        });
      return page([]);
    });
    renderAsk(latestId, "question-1");
    await waitFor(() => expect(savedPanel()?.focusDraft).toBe(PREFIX));
  });

  it("drops the item's draft with the focus when the user starts another new chat", async () => {
    serve();
    renderAsk(latestId, "question-1");
    await waitFor(() => expect(typeof savedPanel()?.focusDraft).toBe("string"));

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open sidebar" }));
    await user.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(savedPanel()?.focusContract).toBeNull());
    expect(savedPanel()?.focusDraft).toBeUndefined();
  });
});
