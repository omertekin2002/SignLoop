import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BeforeYouSign } from "@/components/before-you-sign";
import {
  decisionItemLabel,
  useBriefDecisions,
  type StoredClarifyDecision,
} from "@/components/clarify-decisions";
import { DownloadBriefButton } from "@/components/download-brief-button";
import { CLARIFY_DECISION_LABEL_MAX_CHARACTERS } from "@/lib/clarify-decisions";
import {
  findingDecisionKey,
  questionDecisionKey,
  unstatedDecisionKey,
} from "@/lib/clarify-keys";
import type { AnalysisResult } from "@/lib/schemas";

const CONTRACT_ID = "11111111-2222-4333-8444-555555555555";
const ANALYSIS_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const REVISION = `sha256:${"a".repeat(64)}`;
const OTHER_REVISION = `sha256:${"b".repeat(64)}`;
const DECISIONS_URL = `/api/contracts/${CONTRACT_ID}/decisions`;
const FIRST_SAVE = "2026-11-20T10:00:00.000Z";
const SECOND_SAVE = "2026-11-21T11:00:00.000Z";
const QUESTION = "Can I cancel early?";
const SOURCE = { contract_id: CONTRACT_ID, revision: REVISION, index_unit: "unicode-code-points" as const };

// Two findings without quotations (keyed by type and `where`), one question, term and renewal
// unstated, and a coverage gap from the extraction warning.
const RESULT = {
  source: SOURCE,
  summary: {
    what_it_is: "A gym membership agreement.",
    payments: { amount: "£45", frequency: "Monthly", fees: [], payment_citation: null },
    term: { start: null, end: null, minimum_term: null },
    renewal: { auto_renew: null, renewal_period: null },
    cancellation: { how: "", notice_period_days: null, notice_period_text: null, penalties: [] },
  },
  red_flags: [
    { type: "Price increase", severity: 3, explanation: "", where: "Clause 4", confidence: 60 },
    { type: "Auto-renewal", severity: 8, explanation: "", where: "Clause 9", confidence: 80 },
  ],
  next_actions: { questions_to_ask: [QUESTION], email_templates: [] },
} as unknown as Partial<AnalysisResult>;

const QUESTION_KEY = questionDecisionKey(QUESTION);
const AUTO_RENEWAL_KEY = findingDecisionKey("Auto-renewal", { where: "Clause 9" });

function decision(overrides: Partial<StoredClarifyDecision> = {}): StoredClarifyDecision {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    contractId: CONTRACT_ID,
    analysisId: ANALYSIS_ID,
    itemKey: QUESTION_KEY,
    sourceRevision: REVISION,
    state: "resolved",
    reason: "The club confirmed it in writing.",
    itemLabel: QUESTION,
    createdAt: FIRST_SAVE,
    updatedAt: FIRST_SAVE,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderCard(
  result: Partial<AnalysisResult> = RESULT,
  { askAnalysisId = ANALYSIS_ID as string | null } = {},
) {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BeforeYouSign
        contractId={CONTRACT_ID}
        extractionWarning="Scanned pages were read with OCR."
        result={result}
        askAnalysisId={askAnalysisId}
        analysisId={ANALYSIS_ID}
      />
    </QueryClientProvider>,
  );
  return { user, queryClient };
}

const region = () => screen.getByRole("region", { name: "Before you sign: what to clarify" });
const recordButtons = () =>
  within(region()).queryAllByRole("button", { name: /^Record decision on / });

function requests(fetchMock: ReturnType<typeof vi.fn>, method: string) {
  return fetchMock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method)
    .map(([url, init]) => ({
      url: String(url),
      body: (init as RequestInit | undefined)?.body
        ? JSON.parse(String((init as RequestInit).body))
        : undefined,
    }));
}

describe("BeforeYouSign decisions", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("offers a decision on every keyed item, naming it, and none on coverage gaps", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [] }));
    renderCard();

    await waitFor(() => expect(recordButtons()).toHaveLength(7));
    expect(recordButtons().map((button) => button.textContent)).toEqual([
      "Record decision on Payment: £45, Monthly",
      "Record decision on Notice period",
      "Record decision on Renewal",
      "Record decision on Term",
      "Record decision on finding: Auto-renewal",
      "Record decision on finding: Price increase",
      "Record decision on question 1",
    ]);
    const gaps = within(region()).getByText("Coverage gaps").closest("section")!;
    expect(within(gaps).queryByRole("button")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(DECISIONS_URL, expect.objectContaining({ cache: "no-store" }));
    expect(within(region()).queryByText(/Decisions from earlier analyses/)).toBeNull();
  });

  it("records a new decision with the item's key, label and the analysis shown", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [] }));
    const { user } = renderCard();
    await user.click(await screen.findByRole("button", { name: "Record decision on question 1" }));

    const form = screen.getByRole("form", { name: "Your decision on question 1" });
    const save = within(form).getByRole("button", { name: "Save decision on question 1" });
    // A state must be chosen first.
    expect(save).toBeDisabled();
    await user.click(within(form).getByRole("radio", { name: "Accepted" }));
    await user.type(
      within(form).getByLabelText("Reason for your decision on question 1"),
      "Early exit costs one month.",
    );
    fetchMock.mockResolvedValueOnce(
      json(decision({ state: "accepted", reason: "Early exit costs one month." })),
    );
    await user.click(save);

    expect(requests(fetchMock, "PUT")).toEqual([
      {
        url: DECISIONS_URL,
        body: {
          analysisId: ANALYSIS_ID,
          itemKey: QUESTION_KEY,
          state: "accepted",
          reason: "Early exit costs one month.",
          itemLabel: QUESTION,
          expectedUpdatedAt: null,
        },
      },
    ]);
    const item = within(region()).getByText(QUESTION).closest("li")!;
    expect(await within(item).findByText("Early exit costs one month.")).toBeInTheDocument();
    expect(within(item).getByText("Accepted")).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: "Edit decision on question 1" })).toBeInTheDocument();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("shows a saved decision on its item and edits it against its revision", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [decision()] }));
    const { user } = renderCard();

    const item = within(region()).getByText(QUESTION).closest("li")!;
    expect(await within(item).findByText("The club confirmed it in writing.")).toBeInTheDocument();
    expect(within(item).getByText("Resolved")).toBeInTheDocument();
    expect(within(item).getByText("Your decision:")).toBeInTheDocument();
    // Only the other six items still offer a new decision.
    expect(recordButtons()).toHaveLength(6);

    await user.click(within(item).getByRole("button", { name: "Edit decision on question 1" }));
    const form = screen.getByRole("form", { name: "Your decision on question 1" });
    expect(within(form).getByRole("radio", { name: "Resolved" })).toBeChecked();
    const reason = within(form).getByLabelText("Reason for your decision on question 1");
    expect(reason).toHaveValue("The club confirmed it in writing.");
    await user.click(within(form).getByRole("radio", { name: "Still open" }));
    await user.clear(reason);
    await user.type(reason, "Waiting for their reply.");
    fetchMock.mockResolvedValueOnce(
      json(decision({ state: "open", reason: "Waiting for their reply.", updatedAt: SECOND_SAVE })),
    );
    await user.click(within(form).getByRole("button", { name: "Save decision on question 1" }));

    expect(requests(fetchMock, "PUT")[0]!.body).toMatchObject({
      state: "open",
      reason: "Waiting for their reply.",
      expectedUpdatedAt: FIRST_SAVE,
    });
    expect(await within(item).findByText("Still open")).toBeInTheDocument();
  });

  it("saves and removes from an open editor at the revision it was opened on, even after a refetch", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [decision()] }));
    const { user, queryClient } = renderCard();
    await user.click(await screen.findByRole("button", { name: "Edit decision on question 1" }));
    const reason = screen.getByLabelText("Reason for your decision on question 1");
    await user.clear(reason);
    await user.type(reason, "My stale draft.");

    // Another tab's change arrives through a refetch (for example after reloading another item).
    const newer = decision({ reason: "Saved in another tab.", updatedAt: SECOND_SAVE });
    act(() => queryClient.setQueryData(["clarify-decisions", CONTRACT_ID], [newer]));
    expect(reason).toHaveValue("My stale draft.");

    fetchMock.mockResolvedValueOnce(json({ error: "Changed elsewhere.", decision: newer }, 409));
    await user.click(screen.getByRole("button", { name: "Save decision on question 1" }));
    expect(requests(fetchMock, "PUT")[0]!.body.expectedUpdatedAt).toBe(FIRST_SAVE);
    expect(await screen.findByText("This decision was changed elsewhere")).toBeInTheDocument();

    // Removing from the editor also uses the revision the draft started from.
    fetchMock.mockImplementation(async () => json({ decisions: [newer] }));
    await user.click(screen.getByRole("button", { name: "Reload the saved decision" }));
    await user.click(screen.getByRole("button", { name: "Edit decision on question 1" }));
    act(() =>
      queryClient.setQueryData(
        ["clarify-decisions", CONTRACT_ID],
        [decision({ reason: "Third tab.", updatedAt: "2026-11-22T12:00:00.000Z" })],
      ),
    );
    fetchMock.mockResolvedValueOnce(json({ error: "Changed elsewhere.", decision: newer }, 409));
    await user.click(screen.getByRole("button", { name: "Remove decision on question 1" }));
    expect(requests(fetchMock, "DELETE")[0]!.body).toEqual({ expectedUpdatedAt: SECOND_SAVE });
  });

  it("keeps an unsaved draft when the report remounts, as it does when an analysis finishes", async () => {
    fetchMock.mockImplementation(async () => json({ decisions: [] }));
    const { user, queryClient } = renderCard();
    await user.click(await screen.findByRole("button", { name: "Record decision on Term" }));
    await user.click(screen.getByRole("radio", { name: "Accepted" }));
    await user.type(screen.getByLabelText("Reason for your decision on Term"), "Half-typed reason");

    // The contract page remounts the report under a new key; the query cache stays.
    cleanup();
    render(
      <QueryClientProvider client={queryClient}>
        <BeforeYouSign
          contractId={CONTRACT_ID}
          extractionWarning={null}
          result={RESULT}
          askAnalysisId={null}
          analysisId={"77777777-7777-4888-8999-aaaaaaaaaaaa"}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText("Reason for your decision on Term")).toHaveValue(
      "Half-typed reason",
    );
    expect(screen.getByRole("radio", { name: "Accepted" })).toBeChecked();

    // Another text's analysis does not show it: the draft is keyed by source revision.
    cleanup();
    render(
      <QueryClientProvider client={queryClient}>
        <BeforeYouSign
          contractId={CONTRACT_ID}
          extractionWarning={null}
          result={{ ...RESULT, source: { ...SOURCE, revision: OTHER_REVISION } } as Partial<AnalysisResult>}
          analysisId={ANALYSIS_ID}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: "Record decision on Term" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Reason for your decision on Term")).toBeNull();
  });

  it("does not let a list read started before a save land over it", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [] }));
    const { user, queryClient } = renderCard();
    await user.click(await screen.findByRole("button", { name: "Record decision on Term" }));
    await user.click(screen.getByRole("radio", { name: "Resolved" }));

    // A reload of another item is still waiting for its list when this save finishes.
    let answerOldRead: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((done) => (answerOldRead = done)));
    act(() => void queryClient.invalidateQueries({ queryKey: ["clarify-decisions", CONTRACT_ID], exact: true }));
    await waitFor(() => expect(requests(fetchMock, "GET")).toHaveLength(2));

    const saved = decision({ itemKey: unstatedDecisionKey("Term"), itemLabel: "Term: Not specified", reason: "" });
    fetchMock.mockResolvedValueOnce(json(saved));
    fetchMock.mockResolvedValueOnce(json({ decisions: [saved] }));
    await user.click(screen.getByRole("button", { name: "Save decision on Term" }));
    expect(await screen.findByRole("button", { name: "Edit decision on Term" })).toBeInTheDocument();
    // The list is read again after the write.
    await waitFor(() => expect(requests(fetchMock, "GET")).toHaveLength(3));

    // The older read answers late, without the new decision; it is ignored.
    await act(async () => answerOldRead(json({ decisions: [] })));
    expect(screen.getByRole("button", { name: "Edit decision on Term" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record decision on Term" })).toBeNull();
  });

  it("cancels an edit without sending anything", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [decision()] }));
    const { user } = renderCard();
    await user.click(await screen.findByRole("button", { name: "Edit decision on question 1" }));
    await user.type(screen.getByLabelText("Reason for your decision on question 1"), " Extra.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText("The club confirmed it in writing.")).toBeInTheDocument();
    expect(requests(fetchMock, "PUT")).toEqual([]);
  });

  it("removes a decision against its revision", async () => {
    const stored = decision();
    fetchMock.mockResolvedValueOnce(json({ decisions: [stored] }));
    const { user } = renderCard();
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await user.click(await screen.findByRole("button", { name: "Remove decision on question 1" }));

    expect(requests(fetchMock, "DELETE")).toEqual([
      { url: `${DECISIONS_URL}/${stored.id}`, body: { expectedUpdatedAt: FIRST_SAVE } },
    ]);
    expect(await screen.findByRole("button", { name: "Record decision on question 1" })).toBeInTheDocument();
    expect(screen.queryByText("The club confirmed it in writing.")).toBeNull();
  });

  it("is keyboard-operable", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [] }));
    const { user } = renderCard();
    const record = await screen.findByRole("button", { name: "Record decision on Term" });
    record.focus();
    await user.keyboard("{Enter}");
    const form = screen.getByRole("form", { name: "Your decision on Term" });
    within(form).getByRole("radio", { name: "Resolved" }).focus();
    await user.keyboard(" ");
    expect(within(form).getByRole("radio", { name: "Resolved" })).toBeChecked();
    await user.keyboard("{ArrowRight}");
    expect(within(form).getByRole("radio", { name: "Accepted" })).toBeChecked();
    await user.tab();
    expect(within(form).getByLabelText("Reason for your decision on Term")).toHaveFocus();
    await user.keyboard("Fixed term confirmed.");
    fetchMock.mockResolvedValueOnce(
      json(
        decision({
          itemKey: unstatedDecisionKey("Term"),
          state: "accepted",
          reason: "Fixed term confirmed.",
          itemLabel: "Term: Not specified",
        }),
      ),
    );
    await user.tab();
    expect(within(form).getByRole("button", { name: "Save decision on Term" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(requests(fetchMock, "PUT")[0]!.body).toMatchObject({
      itemKey: unstatedDecisionKey("Term"),
      state: "accepted",
      itemLabel: "Term: Not specified",
    });
    expect(await screen.findByText("Fixed term confirmed.")).toBeInTheDocument();
  });

  it("shows a conflicting save's stored decision and overwrites nothing until reloaded", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [decision()] }));
    const { user } = renderCard();
    await user.click(await screen.findByRole("button", { name: "Edit decision on question 1" }));
    const reason = screen.getByLabelText("Reason for your decision on question 1");
    await user.clear(reason);
    await user.type(reason, "My newer reasoning.");
    const newer = decision({ state: "accepted", reason: "Saved in another tab.", updatedAt: SECOND_SAVE });
    fetchMock.mockResolvedValueOnce(
      json({ error: "This decision was changed elsewhere.", decision: newer }, 409),
    );
    await user.click(screen.getByRole("button", { name: "Save decision on question 1" }));

    expect(await screen.findByText("This decision was changed elsewhere")).toBeInTheDocument();
    expect(screen.getByText("Saved in another tab.")).toBeInTheDocument();
    // The person's text stays, and there is no way to save over the newer decision from here.
    expect(reason).toHaveValue("My newer reasoning.");
    expect(screen.queryByRole("button", { name: "Save decision on question 1" })).toBeNull();
    expect(requests(fetchMock, "PUT")).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(json({ decisions: [newer] }));
    await user.click(screen.getByRole("button", { name: "Reload the saved decision" }));
    expect(screen.queryByRole("form")).toBeNull();
    const item = within(region()).getByText(QUESTION).closest("li")!;
    expect(within(item).getByText("Saved in another tab.")).toBeInTheDocument();
    expect(within(item).getByText("Accepted")).toBeInTheDocument();
    await waitFor(() => expect(requests(fetchMock, "GET")).toHaveLength(2));
    expect(requests(fetchMock, "PUT")).toHaveLength(1);
  });

  it("shows a conflicting remove's stored decision and keeps it", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [decision()] }));
    const { user } = renderCard();
    const newer = decision({ reason: "Changed in another tab.", updatedAt: SECOND_SAVE });
    fetchMock.mockResolvedValueOnce(json({ error: "Changed elsewhere.", decision: newer }, 409));
    await user.click(await screen.findByRole("button", { name: "Remove decision on question 1" }));

    expect(await screen.findByText("This decision was changed elsewhere")).toBeInTheDocument();
    expect(screen.getByText(/so yours was not removed/)).toBeInTheDocument();
    expect(screen.getByText("Changed in another tab.")).toBeInTheDocument();
    expect(requests(fetchMock, "DELETE")).toHaveLength(1);
  });

  it("explains a 422 and refetches the decisions and the contract", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [] }));
    const { user, queryClient } = renderCard();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await user.click(await screen.findByRole("button", { name: "Record decision on Term" }));
    await user.click(screen.getByRole("radio", { name: "Resolved" }));
    fetchMock.mockResolvedValueOnce(json({ error: "That item is not on this analysis." }, 422));
    fetchMock.mockResolvedValueOnce(json({ decisions: [] }));
    await user.click(screen.getByRole("button", { name: "Save decision on Term" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This item is no longer on the analysis shown",
    );
    await waitFor(() => expect(requests(fetchMock, "GET")).toHaveLength(2));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["contract", CONTRACT_ID] });
  });

  it("keeps the person's text when a save fails", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [] }));
    const { user } = renderCard();
    await user.click(await screen.findByRole("button", { name: "Record decision on Term" }));
    await user.click(screen.getByRole("radio", { name: "Resolved" }));
    await user.type(screen.getByLabelText("Reason for your decision on Term"), "Keep me.");
    fetchMock.mockResolvedValueOnce(json({ error: "boom" }, 500));
    await user.click(screen.getByRole("button", { name: "Save decision on Term" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.getByLabelText("Reason for your decision on Term")).toHaveValue("Keep me.");
  });

  it("still renders the checklist when decisions fail to load, and retries", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "boom" }, 500));
    const { user } = renderCard();

    expect(await within(region()).findByRole("alert")).toHaveTextContent(
      "Your decisions could not be loaded.",
    );
    expect(within(region()).getByText(QUESTION)).toBeInTheDocument();
    expect(within(region()).getByRole("link", { name: "Auto-renewal" })).toBeInTheDocument();
    expect(recordButtons()).toHaveLength(0);

    fetchMock.mockResolvedValueOnce(json({ decisions: [decision()] }));
    await user.click(within(region()).getByRole("button", { name: "Try again to load your decisions" }));
    expect(await screen.findByText("The club confirmed it in writing.")).toBeInTheDocument();
    expect(within(region()).queryByRole("alert")).toBeNull();
  });

  it("gives ambiguous items no control and says why", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [] }));
    renderCard({
      ...RESULT,
      next_actions: { questions_to_ask: [QUESTION, `  ${QUESTION}`], email_templates: [] },
    } as Partial<AnalysisResult>);

    await waitFor(() => expect(recordButtons()).toHaveLength(6));
    const questions = within(region()).getByText("Questions to Ask").closest("section")!;
    expect(within(questions).queryByRole("button")).toBeNull();
    expect(
      within(questions).getAllByText(
        "Appears more than once in this analysis, so a decision can't be attached.",
      ),
    ).toHaveLength(2);
  });

  it("shows no controls without a source revision, hints at a re-run, and lists its decisions as earlier", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [decision()] }));
    const { user } = renderCard({ ...RESULT, source: undefined } as Partial<AnalysisResult>);

    expect(
      await within(region()).findByText(/Re-run the analysis to record them\./),
    ).toBeInTheDocument();
    expect(recordButtons()).toHaveLength(0);
    expect(within(region()).queryByRole("button", { name: /Edit decision/ })).toBeNull();
    const summary = await within(region()).findByText("Decisions from earlier analyses (1)");
    await user.click(summary);
    expect(within(region()).getByText("The club confirmed it in writing.")).toBeVisible();
  });

  it("lists decisions that do not attach under a collapsed earlier group, and removes them there", async () => {
    const otherRevision = decision({ sourceRevision: OTHER_REVISION, reason: "From the old text." });
    const goneItem = decision({
      id: "aaaaaaaa-0000-4000-8000-000000000002",
      itemKey: findingDecisionKey("Late fee", { where: "Clause 2" }),
      itemLabel: "Finding: Late fee",
      state: "accepted",
      reason: "Small amount.",
    });
    const onItem = decision({
      id: "aaaaaaaa-0000-4000-8000-000000000003",
      itemKey: AUTO_RENEWAL_KEY,
      itemLabel: "Finding: Auto-renewal",
      state: "open",
      reason: "Need to ask.",
    });
    fetchMock.mockResolvedValueOnce(json({ decisions: [otherRevision, goneItem, onItem] }));
    const { user } = renderCard();

    // The decision on a current item shows there, not in the earlier group.
    const finding = within(region()).getByRole("link", { name: "Auto-renewal" }).closest("li")!;
    expect(await within(finding).findByText("Need to ask.")).toBeInTheDocument();

    const details = within(region()).getByText("Decisions from earlier analyses (2)").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("From the old text.")).not.toBeVisible();
    await user.click(within(details).getByText("Decisions from earlier analyses (2)"));
    expect(details).toHaveAttribute("open");
    expect(within(details).getByText(QUESTION)).toBeVisible();
    expect(within(details).getByText("Finding: Late fee")).toBeVisible();
    expect(within(details).getByText(/aren't attached to any item above/)).toBeVisible();
    // The question's own item keeps its Record control: an earlier decision is never re-attached.
    expect(screen.getByRole("button", { name: "Record decision on question 1" })).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await user.click(
      within(details).getByRole("button", { name: "Remove earlier decision on Finding: Late fee" }),
    );
    expect(requests(fetchMock, "DELETE")).toEqual([
      { url: `${DECISIONS_URL}/${goneItem.id}`, body: { expectedUpdatedAt: FIRST_SAVE } },
    ]);
    await waitFor(() =>
      expect(within(region()).getByText("Decisions from earlier analyses (1)")).toBeInTheDocument(),
    );
    expect(within(region()).queryByText("Finding: Late fee")).toBeNull();
  });

  it("leaves the checklist's items, order, severities and Ask links unchanged", async () => {
    const snapshot = () => ({
      text: region().textContent,
      links: within(region())
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("aria-label")]),
    });
    // Without an analysis id the card loads no decisions.
    const without = render(
      <BeforeYouSign
        contractId={CONTRACT_ID}
        extractionWarning="Scanned pages were read with OCR."
        result={RESULT}
        askAnalysisId={ANALYSIS_ID}
      />,
    );
    const before = snapshot();
    without.unmount();
    expect(fetchMock).not.toHaveBeenCalled();

    const resolvedFinding = decision({
      itemKey: AUTO_RENEWAL_KEY,
      itemLabel: "Finding: Auto-renewal",
      reason: "",
    });
    fetchMock.mockResolvedValueOnce(json({ decisions: [resolvedFinding] }));
    renderCard();
    await screen.findByRole("button", { name: "Edit decision on finding: Auto-renewal" });
    const after = snapshot();
    expect(after.links).toEqual(before.links);
    // A resolved finding is still listed, first, with its severity.
    const findings = within(region()).getByText("Findings").closest("section")!;
    expect(
      within(findings)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("a")?.textContent),
    ).toEqual(["Auto-renewal", "Price increase"]);
    expect(findings).toHaveTextContent("(severity 8/10)");
  });
});

describe("decisionItemLabel", () => {
  it("trims, collapses whitespace, drops NUL and caps the label at the limit", () => {
    expect(decisionItemLabel("  Notice\u0000 period:\n 30 days ", "x")).toBe("Notice period: 30 days");
    expect(decisionItemLabel("   ", "question 1")).toBe("question 1");
    const long = "é".repeat(CLARIFY_DECISION_LABEL_MAX_CHARACTERS + 20);
    expect([...decisionItemLabel(long, "x")]).toHaveLength(CLARIFY_DECISION_LABEL_MAX_CHARACTERS);
  });
});

describe("useBriefDecisions", () => {
  const fetchMock = vi.fn();
  const createObjectURL = vi.fn((_: Blob) => "blob:brief");

  beforeEach(() => {
    fetchMock.mockReset();
    createObjectURL.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  function BriefButton({ enabled = true }: { enabled?: boolean }) {
    const decisions = useBriefDecisions(CONTRACT_ID, enabled);
    return (
      <>
        <p data-testid="status">{decisions.status}</p>
        <DownloadBriefButton
          contract={{ id: CONTRACT_ID, title: "Gym membership", status: "ANALYZED" }}
          analysis={{ createdAt: FIRST_SAVE, riskBadge: "LOW", resultJson: RESULT }}
          decisions={decisions}
        />
      </>
    );
  }

  async function downloaded(user: ReturnType<typeof userEvent.setup>): Promise<string> {
    createObjectURL.mockClear();
    await user.click(screen.getByRole("button", { name: "Download brief" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    return createObjectURL.mock.calls[0]![0].text();
  }

  it("reads the checklist's decisions from its cache entry, with no request of its own", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [decision()] }));
    const { user, queryClient } = renderCard();
    await screen.findByText("The club confirmed it in writing.");
    expect(requests(fetchMock, "GET")).toHaveLength(1);

    render(
      <QueryClientProvider client={queryClient}>
        <BriefButton />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("status")).toHaveTextContent("loaded");
    const markdown = await downloaded(user);
    expect(markdown).toContain(
      "## Your decisions\n\nThese are your own notes on the items in Before you sign, in your own words.",
    );
    // The date is in the runtime's zone, which these tests do not set.
    expect(markdown).toMatch(
      /- \*\*Question 1:\*\* Can I cancel early\?\n {2}- Your decision: Resolved\n {2}- Last updated: Nov 2[01], 2026\n {2}- Your reason:\n {4}> The club confirmed it in writing\./,
    );
    expect(requests(fetchMock, "GET")).toHaveLength(1);
  });

  it("is loading until the list arrives, and says so in the brief", async () => {
    let resolve: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((done) => (resolve = done)));
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BriefButton />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("status")).toHaveTextContent("loading");
    expect(await downloaded(user)).toContain(
      "## Your decisions\n\nYour decisions are not included: they had not finished loading",
    );

    await act(async () => resolve(json({ decisions: [] })));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("loaded"));
    expect(await downloaded(user)).toContain("## Your decisions\n\nYou haven't recorded any decisions.");
    expect(fetchMock).toHaveBeenCalledWith(DECISIONS_URL, expect.objectContaining({ cache: "no-store" }));
  });

  it("reports a failed load, and keeps a list it already has when a refetch fails", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "nope" }, 500));
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BriefButton />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
    expect(await downloaded(user)).toContain(
      "## Your decisions\n\nYour decisions are not included: they could not be loaded.",
    );

    fetchMock.mockResolvedValueOnce(json({ decisions: [decision()] }));
    await act(() => queryClient.refetchQueries());
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("loaded"));
    fetchMock.mockResolvedValueOnce(json({ error: "nope" }, 500));
    await act(() => queryClient.refetchQueries());
    expect(screen.getByTestId("status")).toHaveTextContent("loaded");
    expect(await downloaded(user)).toContain("> The club confirmed it in writing.");
  });

  it("sends no request while disabled", () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <BriefButton enabled={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("status")).toHaveTextContent("loading");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
