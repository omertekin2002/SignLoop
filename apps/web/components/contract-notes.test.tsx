import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractNotes } from "@/components/contract-notes";
import { CONTRACT_NOTE_MAX_CHARACTERS } from "@/lib/contract-notes";

const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
const NOTES_URL = `/api/contracts/${CONTRACT_ID}/notes`;
const FIRST_SAVE = "2026-10-30T10:00:00.000Z";
const SECOND_SAVE = "2026-10-30T11:00:00.000Z";

type Notes = { acceptanceReasons: string; openQuestions: string; updatedAt: string | null };

function stored(notes: Partial<Notes> = {}) {
  return {
    contractId: CONTRACT_ID,
    acceptanceReasons: "",
    openQuestions: "",
    createdAt: notes.updatedAt ?? null,
    updatedAt: null,
    ...notes,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderNotes(queryClient = newClient()) {
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ContractNotes contractId={CONTRACT_ID} />
    </QueryClientProvider>,
  );
  return { user, queryClient, ...view };
}

const region = () => screen.getByRole("region", { name: "Your notes" });
const acceptField = () => screen.getByLabelText("Why I'd accept");
const questionsField = () => screen.getByLabelText("Open questions");
const saveButton = () => screen.getByRole("button", { name: "Save notes" });
const status = () => within(region()).getByRole("status");

function putBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("ContractNotes", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("is its own labelled region, with fields disabled until the notes load", async () => {
    let resolve: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((done) => (resolve = done)));
    renderNotes();

    expect(region()).toBeInTheDocument();
    expect(within(region()).getByRole("heading", { name: "Your notes" })).toBeInTheDocument();
    expect(acceptField()).toBeDisabled();
    expect(questionsField()).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    expect(status()).toHaveTextContent("Loading your notes…");

    resolve(json(stored({ acceptanceReasons: "Price is fair", updatedAt: FIRST_SAVE })));
    await waitFor(() => expect(acceptField()).toBeEnabled());
    expect(acceptField()).toHaveValue("Price is fair");
    expect(questionsField()).toHaveValue("");
    expect(status()).toHaveTextContent(/^Saved /);
    expect(fetchMock).toHaveBeenCalledWith(NOTES_URL, expect.objectContaining({ cache: "no-store" }));
  });

  it("saves edits with the revision it read, and a later load shows them", async () => {
    fetchMock
      .mockResolvedValueOnce(json(stored()))
      .mockResolvedValueOnce(
        json(stored({ acceptanceReasons: "Cancel any month", openQuestions: "Who pays repairs?", updatedAt: FIRST_SAVE })),
      )
      .mockResolvedValueOnce(
        json(stored({ acceptanceReasons: "Cancel any month", openQuestions: "Who pays repairs?", updatedAt: FIRST_SAVE })),
      );
    const { user, unmount } = renderNotes();
    await waitFor(() => expect(acceptField()).toBeEnabled());
    expect(saveButton()).toBeDisabled();
    expect(status()).toHaveTextContent("");

    await user.type(acceptField(), "Cancel any month");
    await user.type(questionsField(), "Who pays repairs?");
    expect(status()).toHaveTextContent("Unsaved changes");
    await user.click(saveButton());

    await waitFor(() => expect(status()).toHaveTextContent(/^Saved /));
    expect(saveButton()).toBeDisabled();
    expect(putBodies(fetchMock)).toEqual([
      { acceptanceReasons: "Cancel any month", openQuestions: "Who pays repairs?", expectedUpdatedAt: null },
    ]);

    // A fresh page load reads the stored notes back.
    unmount();
    renderNotes();
    await waitFor(() => expect(acceptField()).toHaveValue("Cancel any month"));
    expect(questionsField()).toHaveValue("Who pays repairs?");
  });

  it("shows a load failure with a retry instead of empty fields", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "Internal error" }, 500))
      .mockResolvedValueOnce(json(stored({ openQuestions: "Notice period?", updatedAt: FIRST_SAVE })));
    const { user } = renderNotes();

    await waitFor(() =>
      expect(status()).toHaveTextContent("Your notes could not be loaded. They have not been lost."),
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save notes" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(questionsField()).toHaveValue("Notice period?"));
    expect(questionsField()).toBeEnabled();
  });

  it("keeps the typed text and shows an error when a save fails, then saves on retry", async () => {
    fetchMock
      .mockResolvedValueOnce(json(stored({ acceptanceReasons: "Old", updatedAt: FIRST_SAVE })))
      .mockResolvedValueOnce(json({ error: "Internal error" }, 500))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json(stored({ acceptanceReasons: "Old and new", updatedAt: SECOND_SAVE })));
    const { user } = renderNotes();
    await waitFor(() => expect(acceptField()).toHaveValue("Old"));

    await user.type(acceptField(), " and new");
    await user.click(saveButton());
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        "Your notes could not be saved. Your text is still here, so try again.",
      ),
    );
    expect(acceptField()).toHaveValue("Old and new");
    expect(saveButton()).toBeEnabled();

    // A network failure keeps the text as well.
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(status()).toHaveTextContent(
      "Your notes could not be saved. Your text is still here, so try again.",
    );
    expect(acceptField()).toHaveValue("Old and new");

    await user.click(saveButton());
    await waitFor(() => expect(status()).toHaveTextContent(/^Saved /));
    expect(putBodies(fetchMock).map((body) => body.expectedUpdatedAt)).toEqual([
      FIRST_SAVE,
      FIRST_SAVE,
      FIRST_SAVE,
    ]);
  });

  it("shows newer notes on a conflict without discarding the user's text", async () => {
    const newer = stored({
      acceptanceReasons: "Saved in another tab",
      openQuestions: "Deposit?",
      updatedAt: SECOND_SAVE,
    });
    fetchMock
      .mockResolvedValueOnce(json(stored({ acceptanceReasons: "Draft one", updatedAt: FIRST_SAVE })))
      .mockResolvedValueOnce(
        json({ error: "These notes were changed elsewhere. Reload them before saving again.", notes: newer }, 409),
      );
    const { user } = renderNotes();
    await waitFor(() => expect(acceptField()).toHaveValue("Draft one"));

    await user.clear(acceptField());
    await user.type(acceptField(), "My version");
    await user.click(saveButton());

    await waitFor(() =>
      expect(status()).toHaveTextContent("Not saved: these notes were changed elsewhere."),
    );
    expect(screen.getByText("These notes were changed elsewhere")).toBeInTheDocument();
    expect(screen.getByText("Saved in another tab")).toBeInTheDocument();
    expect(screen.getByText("Deposit?")).toBeInTheDocument();
    // The user's text stays in the field, and nothing saves until they choose.
    expect(acceptField()).toHaveValue("My version");
    expect(screen.queryByRole("button", { name: "Save notes" })).not.toBeInTheDocument();
    expect(putBodies(fetchMock)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Use the saved version" }));
    expect(acceptField()).toHaveValue("Saved in another tab");
    expect(questionsField()).toHaveValue("Deposit?");
    expect(screen.queryByText("These notes were changed elsewhere")).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(status()).toHaveTextContent(/^Saved /);
  });

  it("replaces newer notes with the user's text only when they choose to", async () => {
    const newer = stored({ acceptanceReasons: "Theirs", updatedAt: SECOND_SAVE });
    let finishReplace: (response: Response) => void = () => {};
    fetchMock
      .mockResolvedValueOnce(json(stored({ updatedAt: FIRST_SAVE })))
      .mockResolvedValueOnce(json({ error: "conflict", notes: newer }, 409))
      .mockReturnValueOnce(new Promise<Response>((done) => (finishReplace = done)));
    const { user } = renderNotes();
    await waitFor(() => expect(acceptField()).toBeEnabled());

    await user.type(acceptField(), "Mine");
    await user.click(saveButton());
    await user.click(await screen.findByRole("button", { name: "Replace it with mine" }));

    // Neither choice can be made again while the replacement is saving.
    await waitFor(() => expect(status()).toHaveTextContent("Saving…"));
    expect(screen.getByRole("button", { name: "Use the saved version" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replace it with mine" })).toBeDisabled();
    finishReplace(json(stored({ acceptanceReasons: "Mine", updatedAt: "2026-10-30T12:00:00.000Z" })));

    await waitFor(() => expect(status()).toHaveTextContent(/^Saved /));
    expect(acceptField()).toHaveValue("Mine");
    expect(putBodies(fetchMock)).toEqual([
      { acceptanceReasons: "Mine", openQuestions: "", expectedUpdatedAt: FIRST_SAVE },
      { acceptanceReasons: "Mine", openQuestions: "", expectedUpdatedAt: SECOND_SAVE },
    ]);
  });

  it("treats a conflict that already holds the user's text as saved", async () => {
    fetchMock
      .mockResolvedValueOnce(json(stored({ updatedAt: FIRST_SAVE })))
      .mockResolvedValueOnce(
        json({ error: "conflict", notes: stored({ openQuestions: "Same", updatedAt: SECOND_SAVE }) }, 409),
      );
    const { user } = renderNotes();
    await waitFor(() => expect(questionsField()).toBeEnabled());

    await user.type(questionsField(), "Same");
    await user.click(saveButton());

    await waitFor(() => expect(status()).toHaveTextContent(/^Saved /));
    expect(screen.queryByText("These notes were changed elsewhere")).not.toBeInTheDocument();
  });

  it("keeps unsaved text when the contract page remounts the card", async () => {
    // The stored notes are collected after five minutes too, so the remount reads them again.
    fetchMock.mockImplementation(async () => json(stored({ updatedAt: FIRST_SAVE })));
    // Fake from the start, so the cache schedules its garbage collection on them.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const queryClient = newClient();
      const first = renderNotes(queryClient);
      await waitFor(() => expect(acceptField()).toBeEnabled());
      await first.user.type(acceptField(), "Half-written thought");

      // Longer than the query cache's default garbage-collection time.
      first.unmount();
      vi.advanceTimersByTime(10 * 60_000);

      renderNotes(queryClient);
      expect(acceptField()).toHaveValue("Half-written thought");
      expect(status()).toHaveTextContent("Unsaved changes");
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(acceptField()).toHaveValue("Half-written thought");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the character count near the limit and refuses to save over it", async () => {
    const nearLimit = "a".repeat(CONTRACT_NOTE_MAX_CHARACTERS - 1);
    fetchMock.mockResolvedValueOnce(json(stored({ acceptanceReasons: nearLimit, updatedAt: FIRST_SAVE })));
    const { user } = renderNotes();
    await waitFor(() => expect(acceptField()).toHaveValue(nearLimit));

    expect(acceptField()).toHaveAccessibleDescription("9,999 of 10,000 characters");
    expect(questionsField()).not.toHaveAccessibleDescription();

    // Code points, not UTF-16 units: an emoji counts once.
    await user.type(acceptField(), "😀");
    expect(acceptField()).toHaveAccessibleDescription("10,000 of 10,000 characters");
    expect(saveButton()).toBeEnabled();

    await user.type(acceptField(), "b");
    expect(acceptField()).toHaveAttribute("aria-invalid", "true");
    expect(saveButton()).toBeDisabled();
    expect(status()).toHaveTextContent("Not saved: each note can be at most 10,000 characters.");
  });
});
