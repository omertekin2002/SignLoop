import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractChats } from "@/components/contract-chats";
import { refreshWorkspaceList } from "@/lib/use-workspace-list";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiClient: { get: mocks.get },
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";

function chat(n: number, messageCount = 2) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    userId: "user",
    title: `Lease question ${n}`,
    createdAt: "2026-11-20T09:00:00.000Z",
    updatedAt: `2026-11-2${n % 10}T10:30:00.000Z`,
    messageCount,
  };
}

/** Serves `total` chats newest first, in pages of the requested size. */
function serveChats(total: number) {
  const all = Array.from({ length: total }, (_, index) => chat(index + 1, index === 0 ? 1 : 4));
  mocks.get.mockImplementation(async (url: string) => {
    const { pathname, searchParams } = new URL(url, "https://app.test");
    if (pathname !== "/chat/threads") throw new Error(`unexpected ${url}`);
    const limit = Number(searchParams.get("limit"));
    const offset = Number(searchParams.get("offset"));
    return { data: { data: all.slice(offset, offset + limit), total, limit, offset } };
  });
  return all;
}

function renderChats({ canAsk = true, client = new QueryClient({ defaultOptions: { queries: { retry: false } } }) } = {}) {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <ContractChats contractId={CONTRACT_ID} canAsk={canAsk} />
    </QueryClientProvider>,
  );
  return { user, client };
}

const region = () => screen.getByRole("region", { name: "Chats about this contract" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ContractChats", () => {
  it("lists this contract's chats with their title, last activity and message count, each linking to the dashboard", async () => {
    const [first, second] = serveChats(2);
    renderChats();

    const links = await within(region()).findAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", `/dashboard?thread=${first!.id}`);
    expect(links[0]).toHaveTextContent("Lease question 1");
    expect(links[0]).toHaveTextContent("1 message");
    expect(links[0]).not.toHaveTextContent("1 messages");
    expect(links[1]).toHaveAttribute("href", `/dashboard?thread=${second!.id}`);
    expect(links[1]).toHaveTextContent("4 messages");
    const time = links[1]!.querySelector("time");
    expect(time).toHaveAttribute("dateTime", second!.updatedAt);
    expect(links[1]).toHaveTextContent(/Last active Nov \d+, \d\d:\d\d/);
    // Only this contract's chats are asked for, ten at a time.
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(
      `/chat/threads?contract=${CONTRACT_ID}&limit=10&offset=0`,
      expect.anything(),
    );
    expect(within(region()).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("shows more than one page of chats with Show more", async () => {
    serveChats(13);
    const { user } = renderChats();

    expect(await within(region()).findAllByRole("link")).toHaveLength(10);
    await user.click(within(region()).getByRole("button", { name: "Show more" }));

    await waitFor(() => expect(within(region()).getAllByRole("link")).toHaveLength(13));
    expect(within(region()).getAllByRole("link").at(-1)).toHaveTextContent("Lease question 13");
    expect(mocks.get).toHaveBeenLastCalledWith(
      `/chat/threads?contract=${CONTRACT_ID}&limit=10&offset=10`,
      expect.anything(),
    );
    expect(within(region()).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("shows the empty state, pointing at Ask about this contract only when the contract has text", async () => {
    serveChats(0);
    renderChats();
    expect(
      await within(region()).findByText(
        "No chats about this contract yet. Start one with Ask about this contract.",
      ),
    ).toBeInTheDocument();
    expect(within(region()).queryByRole("link")).toBeNull();
  });

  it("shows only the empty-state text for a contract with no text", async () => {
    serveChats(0);
    renderChats({ canAsk: false });
    expect(
      await within(region()).findByText("No chats about this contract yet."),
    ).toBeInTheDocument();
    expect(within(region()).queryByText(/Ask about this contract/)).toBeNull();
  });

  it("refreshes when the dashboard refreshes its chat list, so a deleted chat leaves it", async () => {
    const [, second] = serveChats(2);
    const { client } = renderChats();
    expect(await within(region()).findAllByRole("link")).toHaveLength(2);

    mocks.get.mockImplementation(async (url: string) => {
      const { searchParams } = new URL(url, "https://app.test");
      const rows = searchParams.get("contract") ? [second] : [];
      return { data: { data: rows, total: rows.length, limit: 10, offset: 0 } };
    });
    await refreshWorkspaceList(client, "chat-threads", "/chat/threads");

    await waitFor(() => expect(within(region()).getAllByRole("link")).toHaveLength(1));
    expect(within(region()).getByRole("link")).toHaveTextContent("Lease question 2");
  });

  it("says the list could not be loaded, and tries again", async () => {
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    const { user } = renderChats();

    const alert = await within(region()).findByRole("alert");
    expect(alert).toHaveTextContent("Your chats about this contract could not be loaded.");

    serveChats(1);
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(region()).findAllByRole("link")).toHaveLength(1);
  });
});
