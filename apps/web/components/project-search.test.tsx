import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  ProjectSearchField,
  ProjectSearchResults,
  useWorkspaceSearch,
  type SearchableProject,
} from "@/components/contract-search";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api-client", () => ({ apiClient: { get: mocks.get } }));

type Page = {
  data: SearchableProject[];
  total: number;
  limit: number;
  offset: number;
};

function page(
  data: SearchableProject[],
  total = data.length,
  offset = 0,
): { data: Page } {
  return { data: { data, total, limit: 50, offset } };
}

function requestUrl(call: unknown[]) {
  return new URL(String(call[0]), "https://app.test");
}

// Mirrors the dashboard: the field above, search results while a term is active, the list otherwise.
function Harness() {
  const search = useWorkspaceSearch();
  return (
    <>
      <ProjectSearchField
        value={search.input}
        onChange={search.setInput}
        onClear={search.clear}
      />
      {search.search ? (
        <ProjectSearchResults<SearchableProject>
          search={search.search}
          enabled
          onClear={search.clear}
          renderProjects={(projects) => (
            <ul>
              {projects.map((project) => (
                <li key={project.id}>{project.title}</li>
              ))}
            </ul>
          )}
          renderLoadError={(retry) => (
            <div role="alert">
              Couldn&apos;t load projects
              <button type="button" onClick={retry}>
                Try again
              </button>
            </div>
          )}
        />
      ) : (
        <p>All projects</p>
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

beforeEach(() => mocks.get.mockReset());

describe("project name search", () => {
  it("searches the projects list after typing pauses, with a count", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(
      page([
        { id: "a", title: "Warehouse leases" },
        { id: "b", title: "Office leases" },
      ]),
    );
    renderWithClient(<Harness />);

    const field = screen.getByRole("searchbox", { name: "Search projects" });
    expect(field).toHaveAttribute("placeholder", "Search by project name");
    expect(field).toHaveAttribute("maxLength", "200");
    await user.type(field, "  leases ");
    expect(screen.getByText("All projects")).toBeInTheDocument();

    expect(await screen.findByText("Warehouse leases")).toBeInTheDocument();
    expect(screen.getByText("Office leases")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 projects match “leases”",
    );
    // One request for the settled, trimmed term against the projects list.
    expect(mocks.get).toHaveBeenCalledOnce();
    const url = requestUrl(mocks.get.mock.calls[0]!);
    expect(url.pathname).toBe("/projects");
    expect(url.searchParams.get("q")).toBe("leases");
    expect(url.searchParams.get("standalone")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("says when exactly one project matches", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(page([{ id: "a", title: "Vendors" }]));
    renderWithClient(<Harness />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search projects" }),
      "vendor",
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "1 project matches “vendor”",
    );
  });

  it("keeps searches under the projects query key, so project changes refresh them", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(page([{ id: "a", title: "Vendors" }]));
    const client = renderWithClient(<Harness />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search projects" }),
      "vendor",
    );
    await screen.findByText("Vendors");

    mocks.get.mockResolvedValue(page([{ id: "b", title: "Vendors renamed" }]));
    await client.invalidateQueries({ queryKey: ["projects"] });

    expect(await screen.findByText("Vendors renamed")).toBeInTheDocument();
    expect(client.getQueryData(["projects", { q: "vendor" }])).toBeDefined();
  });

  it("shows a distinct no-match state whose Clear search restores the list", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(page([]));
    renderWithClient(<Harness />);

    const field = screen.getByRole("searchbox", { name: "Search projects" });
    await user.type(field, "zebra");

    expect(
      await screen.findByRole("heading", {
        name: "No projects match “zebra”",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Search looks at project names. Try a shorter or different word.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No projects yet")).not.toBeInTheDocument();

    const clearButtons = screen.getAllByRole("button", {
      name: "Clear search",
    });
    await user.click(clearButtons[clearButtons.length - 1]!);

    expect(screen.getByText("All projects")).toBeInTheDocument();
    expect(field).toHaveValue("");
  });

  it("clears from the field with Escape", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(page([]));
    renderWithClient(<Harness />);

    const field = screen.getByRole("searchbox", { name: "Search projects" });
    await user.type(field, "zebra");
    await screen.findByRole("heading", { name: "No projects match “zebra”" });
    await user.keyboard("{Escape}");

    expect(field).toHaveValue("");
    expect(screen.getByText("All projects")).toBeInTheDocument();
  });

  it("shows the load-error state with a retry instead of an empty result", async () => {
    const user = userEvent.setup();
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    renderWithClient(<Harness />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search projects" }),
      "vendor",
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load projects");
    expect(
      screen.queryByRole("heading", { name: /No projects match/ }),
    ).not.toBeInTheDocument();

    mocks.get.mockResolvedValueOnce(page([{ id: "a", title: "Vendors" }]));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Vendors")).toBeInTheDocument();
  });

  it("pages through more than 50 results with Load more", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 55 }, (_, index) => ({
      id: `p${index}`,
      title: `Deal ${index}`,
    }));
    mocks.get.mockImplementation(async (url: string) => {
      const offset = Number(requestUrl([url]).searchParams.get("offset"));
      return page(rows.slice(offset, offset + 50), rows.length, offset);
    });
    renderWithClient(<Harness />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search projects" }),
      "deal",
    );
    expect(await screen.findByText("Deal 49")).toBeInTheDocument();
    expect(screen.queryByText("Deal 50")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "55 projects match “deal”",
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Deal 54")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      mocks.get.mock.calls.map((call) =>
        requestUrl(call).searchParams.get("offset"),
      ),
    ).toEqual(["0", "50"]);
  });
});
