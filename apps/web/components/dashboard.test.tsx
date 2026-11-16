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
// The chat itself is not under test, and its runtime needs a browser.
vi.mock("@/components/chat-panel", () => ({ ChatPanel: () => null }));

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
