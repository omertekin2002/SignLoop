import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadBriefButton } from "@/components/download-brief-button";
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
});
