import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  ChatSearchField,
  ChatSearchResults,
  useWorkspaceSearch,
  type SearchableChatThread,
} from "@/components/contract-search";
import { refreshWorkspaceList } from "@/lib/use-workspace-list";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api-client", () => ({ apiClient: { get: mocks.get } }));

type Page = {
  data: SearchableChatThread[];
  total: number;
  limit: number;
  offset: number;
};

function page(
  data: SearchableChatThread[],
  total = data.length,
  offset = 0,
): { data: Page } {
  return { data: { data, total, limit: 50, offset } };
}

function requestUrl(call: unknown[]) {
  return new URL(String(call[0]), "https://app.test");
}

// Mirrors the sidebar: the field, search results while a term is active, the saved list otherwise.
function Harness({ onSelect = () => {} }: { onSelect?: (id: string) => void }) {
  const search = useWorkspaceSearch();
  return (
    <>
      <ChatSearchField
        value={search.input}
        onChange={search.setInput}
        onClear={search.clear}
      />
      {search.search ? (
        <ChatSearchResults<SearchableChatThread>
          search={search.search}
          enabled
          onClear={search.clear}
          renderThreads={(threads) =>
            threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => onSelect(thread.id)}
              >
                {thread.title}
              </button>
            ))
          }
          renderLoadError={(retry) => (
            <button type="button" onClick={retry}>
              Couldn&apos;t search chats. Retry
            </button>
          )}
        />
      ) : (
        <p>All chats</p>
      )}
    </>
  );
}

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

// A block body: a function returned from beforeEach would run as teardown.
beforeEach(() => {
  mocks.get.mockReset();
});

describe("chat title search", () => {
  it("searches saved chats after typing pauses, with a count", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(
      page([
        { id: "a", title: "Lease renewal questions" },
        { id: "b", title: "Office lease review" },
      ]),
    );
    renderWithClient(<Harness />);

    const field = screen.getByRole("searchbox", { name: "Search chats" });
    expect(field).toHaveAttribute("placeholder", "Search chats by title");
    // The field caps its value in code points itself; a native maxLength counts UTF-16 code units.
    expect(field).not.toHaveAttribute("maxLength");
    await user.type(field, "  lease ");
    expect(screen.getByText("All chats")).toBeInTheDocument();

    expect(
      await screen.findByRole("button", { name: "Lease renewal questions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Office lease review" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 chats match “lease”",
    );
    // One request for the settled, trimmed term against the chat threads list.
    expect(mocks.get).toHaveBeenCalledOnce();
    const url = requestUrl(mocks.get.mock.calls[0]!);
    expect(url.pathname).toBe("/chat/threads");
    expect(url.searchParams.get("q")).toBe("lease");
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("shows a searching state while the first page loads", async () => {
    const user = userEvent.setup();
    let finish!: (value: { data: Page }) => void;
    mocks.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderWithClient(<Harness />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search chats" }),
      "lease",
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Searching chats…"),
    );
    finish(page([{ id: "a", title: "Lease" }]));
    expect(
      await screen.findByRole("button", { name: "Lease" }),
    ).toBeInTheDocument();
  });

  it("says when exactly one chat matches, and opens it when selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    mocks.get.mockResolvedValue(page([{ id: "a", title: "Vendor terms" }]));
    renderWithClient(<Harness onSelect={onSelect} />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search chats" }),
      "vendor",
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "1 chat matches “vendor”",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Vendor terms" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("shows a distinct no-match state whose Clear search restores the list", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(page([]));
    renderWithClient(<Harness />);

    const field = screen.getByRole("searchbox", { name: "Search chats" });
    await user.type(field, "zebra");

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "No chats match “zebra”",
      ),
    );
    expect(
      screen.getByText(
        "Search looks at chat titles. Try a shorter or different word.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();

    const clearButtons = screen.getAllByRole("button", {
      name: "Clear search",
    });
    // The field's own clear button and the no-match state's.
    expect(clearButtons).toHaveLength(2);
    await user.click(clearButtons[clearButtons.length - 1]!);

    expect(screen.getByText("All chats")).toBeInTheDocument();
    expect(field).toHaveValue("");
  });

  it("clears from the field with Escape", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(page([]));
    renderWithClient(<Harness />);

    const field = screen.getByRole("searchbox", { name: "Search chats" });
    await user.type(field, "zebra");
    await screen.findByText("No chats match “zebra”");
    await user.keyboard("{Escape}");

    expect(field).toHaveValue("");
    expect(screen.getByText("All chats")).toBeInTheDocument();
  });

  it("shows the load-error state with a retry instead of an empty result", async () => {
    const user = userEvent.setup();
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    renderWithClient(<Harness />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search chats" }),
      "vendor",
    );

    const retry = await screen.findByRole("button", {
      name: "Couldn't search chats. Retry",
    });
    expect(screen.queryByText(/No chats match/)).not.toBeInTheDocument();
    expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();

    mocks.get.mockResolvedValueOnce(page([{ id: "a", title: "Vendors" }]));
    await user.click(retry);
    expect(
      await screen.findByRole("button", { name: "Vendors" }),
    ).toBeInTheDocument();
  });

  it("pages through more than 50 results with Load more", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 55 }, (_, index) => ({
      id: `t${index}`,
      title: `Deal ${index}`,
    }));
    mocks.get.mockImplementation(async (url: string) => {
      const offset = Number(requestUrl([url]).searchParams.get("offset"));
      return page(rows.slice(offset, offset + 50), rows.length, offset);
    });
    renderWithClient(<Harness />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search chats" }),
      "deal",
    );
    expect(
      await screen.findByRole("button", { name: "Deal 49" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Deal 50")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "55 chats match “deal”",
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(
      await screen.findByRole("button", { name: "Deal 54" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      mocks.get.mock.calls.map((call) =>
        requestUrl(call).searchParams.get("q"),
      ),
    ).toEqual(["deal", "deal"]);
    expect(
      mocks.get.mock.calls.map((call) =>
        requestUrl(call).searchParams.get("offset"),
      ),
    ).toEqual(["0", "50"]);
  });

  it("refreshes an open search when a new or retitled chat refreshes the list", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(page([{ id: "a", title: "Lease draft" }]));
    const client = renderWithClient(<Harness />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search chats" }),
      "lease",
    );
    await screen.findByRole("button", { name: "Lease draft" });

    // The chat panel refreshes the unfiltered list after creating a chat or finishing a turn.
    mocks.get.mockImplementation(async (url: string) =>
      requestUrl([url]).searchParams.get("q")
        ? page([
            { id: "b", title: "Lease renewal" },
            { id: "a", title: "Lease draft" },
          ])
        : page([{ id: "b", title: "Lease renewal" }]),
    );
    await refreshWorkspaceList(client, "chat-threads", "/chat/threads");

    expect(
      await screen.findByRole("button", { name: "Lease renewal" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 chats match “lease”",
    );
  });

  it("drops a deleted chat from an open search when the list is invalidated", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(
      page([
        { id: "a", title: "Lease draft" },
        { id: "b", title: "Lease renewal" },
      ]),
    );
    const client = renderWithClient(<Harness />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search chats" }),
      "lease",
    );
    await screen.findByRole("button", { name: "Lease draft" });

    mocks.get.mockResolvedValue(page([{ id: "b", title: "Lease renewal" }]));
    // Deleting a chat invalidates the ["chat-threads"] prefix.
    await client.invalidateQueries({ queryKey: ["chat-threads"] });

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Lease draft" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 chat matches “lease”",
    );
    expect(client.getQueryData(["chat-threads", { q: "lease" }])).toBeDefined();
  });
});
