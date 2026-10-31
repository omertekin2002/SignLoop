import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractSearchField,
  ContractSearchResults,
  useContractSearch,
  type SearchableContract,
} from "@/components/contract-search";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api-client", () => ({ apiClient: { get: mocks.get } }));

type Page = {
  data: SearchableContract[];
  total: number;
  limit: number;
  offset: number;
};

function page(
  data: SearchableContract[],
  total = data.length,
  offset = 0,
): { data: Page } {
  return { data: { data, total, limit: 50, offset } };
}

function urlParams(call: unknown[]) {
  return new URL(String(call[0]), "https://app.test").searchParams;
}

// Mirrors the dashboard: the field above, search results while a term is active, the list otherwise.
function Harness() {
  const search = useContractSearch();
  return (
    <>
      <ContractSearchField
        value={search.input}
        onChange={search.setInput}
        onClear={search.clear}
      />
      {search.search ? (
        <ContractSearchResults<SearchableContract>
          search={search.search}
          enabled
          onClear={search.clear}
          renderContracts={(contracts) => (
            <ul>
              {contracts.map((contract) => (
                <li key={contract.id}>
                  {contract.title}
                  {contract.projectTitle ? ` (${contract.projectTitle})` : ""}
                </li>
              ))}
            </ul>
          )}
          renderLoadError={(retry) => (
            <div role="alert">
              Couldn&apos;t load contracts
              <button type="button" onClick={retry}>
                Try again
              </button>
            </div>
          )}
        />
      ) : (
        <p>Standalone list</p>
      )}
    </>
  );
}

function renderHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => mocks.get.mockReset());

describe("contract title search", () => {
  it("searches after typing pauses and names the project of each result", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(
      page([
        {
          id: "a",
          title: "Warehouse lease",
          projectId: "p",
          projectTitle: "Property",
        },
        { id: "b", title: "Office lease", projectId: null, projectTitle: null },
      ]),
    );
    renderHarness();

    const field = screen.getByRole("searchbox", { name: "Search contracts" });
    await user.type(field, "  lease ");
    expect(screen.getByText("Standalone list")).toBeInTheDocument();

    expect(
      await screen.findByText("Warehouse lease (Property)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Office lease")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 contracts match “lease”",
    );
    // One request for the settled, trimmed term rather than one per keystroke.
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(urlParams(mocks.get.mock.calls[0]!).get("q")).toBe("lease");
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("shows a distinct no-match state whose Clear search restores the list", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(page([]));
    renderHarness();

    const field = screen.getByRole("searchbox", { name: "Search contracts" });
    await user.type(field, "zebra");

    expect(
      await screen.findByRole("heading", {
        name: "No contracts match “zebra”",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No contracts found")).not.toBeInTheDocument();

    const clearButtons = screen.getAllByRole("button", {
      name: "Clear search",
    });
    await user.click(clearButtons[clearButtons.length - 1]!);

    expect(screen.getByText("Standalone list")).toBeInTheDocument();
    expect(field).toHaveValue("");
    expect(
      screen.queryByRole("heading", { name: /No contracts match/ }),
    ).not.toBeInTheDocument();
  });

  it("clears from the field with Escape", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(page([]));
    renderHarness();

    const field = screen.getByRole("searchbox", { name: "Search contracts" });
    await user.type(field, "zebra");
    await screen.findByRole("heading", { name: "No contracts match “zebra”" });
    await user.keyboard("{Escape}");

    expect(field).toHaveValue("");
    expect(screen.getByText("Standalone list")).toBeInTheDocument();
  });

  it("shows the load-error state with a retry instead of an empty result", async () => {
    const user = userEvent.setup();
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    renderHarness();

    await user.type(
      screen.getByRole("searchbox", { name: "Search contracts" }),
      "lease",
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load contracts");
    expect(
      screen.queryByRole("heading", { name: /No contracts match/ }),
    ).not.toBeInTheDocument();

    mocks.get.mockResolvedValueOnce(page([{ id: "a", title: "Office lease" }]));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Office lease")).toBeInTheDocument();
  });

  it("pages through more than 50 results with Load more", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 55 }, (_, index) => ({
      id: `c${index}`,
      title: `Lease ${index}`,
    }));
    mocks.get.mockImplementation(async (url: string) => {
      const offset = Number(urlParams([url]).get("offset"));
      return page(rows.slice(offset, offset + 50), rows.length, offset);
    });
    renderHarness();

    await user.type(
      screen.getByRole("searchbox", { name: "Search contracts" }),
      "lease",
    );
    expect(await screen.findByText("Lease 49")).toBeInTheDocument();
    expect(screen.queryByText("Lease 50")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "55 contracts match “lease”",
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Lease 54")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      mocks.get.mock.calls.map((call) => urlParams(call).get("offset")),
    ).toEqual(["0", "50"]);
    expect(
      mocks.get.mock.calls.every(
        (call) => urlParams(call).get("q") === "lease",
      ),
    ).toBe(true);
  });
});
