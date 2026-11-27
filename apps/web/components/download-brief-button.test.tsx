import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadBriefButton } from "@/components/download-brief-button";
import { questionDecisionKey } from "@/lib/clarify-keys";
import type { AnalysisResult } from "@/lib/schemas";

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const CONTRACT = {
  id: "11111111-2222-4333-8444-555555555555",
  title: "Gym membership",
  status: "ANALYZED",
  extractionWarning: "Scanned pages were read with OCR.",
};

const SOURCE = {
  contract_id: CONTRACT.id,
  revision: `sha256:${"a".repeat(64)}`,
  index_unit: "unicode-code-points" as const,
};
const QUESTION = "Can I cancel early?";

const RESULT: Partial<AnalysisResult> = {
  risk_badge: "MEDIUM",
  key_points: ["Renews every year."],
  red_flags: [],
  disclaimer: "This is an AI analysis, not legal advice.",
};

const ANALYSIS = {
  createdAt: "2026-10-29",
  riskBadge: "MEDIUM",
  resultJson: RESULT,
};

const BUTTON = { name: "Download brief" };

describe("DownloadBriefButton", () => {
  const fetchMock = vi.fn();
  const createObjectURL = vi.fn((_: Blob) => "blob:brief");
  const revokeObjectURL = vi.fn();
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockReset();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    mocks.toast.error.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    // jsdom implements neither object URLs nor navigation for a download link.
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    clicked = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        clicked.push(this);
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders nothing until an analysis exists", () => {
    const { rerender } = render(
      <DownloadBriefButton contract={CONTRACT} analysis={null} />,
    );
    expect(screen.queryByRole("button", BUTTON)).not.toBeInTheDocument();

    rerender(
      <DownloadBriefButton
        contract={CONTRACT}
        analysis={{ ...ANALYSIS, resultJson: null }}
      />,
    );
    expect(screen.queryByRole("button", BUTTON)).not.toBeInTheDocument();

    rerender(<DownloadBriefButton contract={CONTRACT} analysis={ANALYSIS} />);
    expect(screen.getByRole("button", BUTTON)).toBeInTheDocument();
  });

  it("downloads a Markdown brief built in the browser, without a network request", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DownloadBriefButton contract={CONTRACT} analysis={ANALYSIS} />);

    await user.click(screen.getByRole("button", BUTTON));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toMatch(/^text\/markdown/);
    const markdown = await blob.text();
    expect(markdown).toContain("# Decision brief: Gym membership");
    expect(markdown).toContain("- **Text extraction:** Scanned pages were read with OCR.");

    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe("signloop-brief-gym-membership-2026-10-29.md");
    expect(clicked[0]!.href).toBe("blob:brief");
    expect(clicked[0]!.isConnected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();

    // The object URL is released once the browser has had time to start saving.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:brief");
  });
  it("adds the person's decisions under Your decisions, and leaves them out without them", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const analysis = {
      ...ANALYSIS,
      resultJson: {
        ...RESULT,
        source: SOURCE,
        next_actions: { questions_to_ask: [QUESTION], email_templates: [] },
      },
    };
    const { rerender } = render(
      <DownloadBriefButton
        contract={CONTRACT}
        analysis={analysis}
        decisions={{
          status: "loaded",
          decisions: [
            {
              itemKey: questionDecisionKey(QUESTION),
              sourceRevision: SOURCE.revision,
              state: "accepted",
              reason: "# Fine by me\n- no penalty <b>at all</b>",
              itemLabel: QUESTION,
              updatedAt: "2026-11-20T12:00:00.000Z",
            },
          ],
        }}
      />,
    );
    const download = async (call: number) => {
      await user.click(screen.getByRole("button", BUTTON));
      return createObjectURL.mock.calls[call]![0].text();
    };

    const markdown = await download(0);
    const sections: string[] = markdown.match(/^## .+$/gm) ?? [];
    expect(sections.indexOf("## Your decisions")).toBe(
      sections.indexOf("## Before you sign: what to clarify") + 1,
    );
    expect(markdown).toContain(`- **Question 1:** ${QUESTION}\n  - Your decision: Accepted\n`);
    // The reason's heading, list marker and HTML are escaped, line by line, inside its quote.
    expect(markdown).toContain(
      "  - Your reason:\n    > \\# Fine by me\n    > \\- no penalty \\<b\\>at all\\</b\\>\n",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(
      <DownloadBriefButton contract={CONTRACT} analysis={analysis} decisions={{ status: "error" }} />,
    );
    expect(await download(1)).toContain(
      "## Your decisions\n\nYour decisions are not included: they could not be loaded. They have not been lost.\n",
    );

    rerender(<DownloadBriefButton contract={CONTRACT} analysis={analysis} />);
    expect(await download(2)).not.toContain("Your decisions");
  });
});
