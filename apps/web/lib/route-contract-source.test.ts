import { beforeEach, describe, expect, it, vi } from "vitest";
const { auth, getAnalysisForUser, getContractSourceForUser } = vi.hoisted(
  () => ({
    auth: vi.fn(),
    getAnalysisForUser: vi.fn(),
    getContractSourceForUser: vi.fn(),
  }),
);
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  getAnalysisForUser,
  getContractSourceForUser,
}));
import { GET } from "@/app/api/contracts/[id]/source/route";
import {
  attachAnalysisSources,
  contractSourceRevision,
} from "./analysis-sources";
const id = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const analysisId = "22e3e947-f71f-4ecd-a901-adbf24edbb8a";
const revision = contractSourceRevision("A fee applies.");
const params = { params: Promise.resolve({ id }) };
const get = (query = "") =>
  GET(
    new Request(`http://localhost/api/contracts/${id}/source${query}`),
    params,
  );
const finding = `?revision=${revision}&analysisId=${analysisId}&flag=0`;
beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({ userId: "owner" });
  getContractSourceForUser.mockResolvedValue({
    revision,
    text: "A fee applies.",
    totalCharacters: 14,
    extractionWarning: null,
    highlightMatches: true,
  });
  getAnalysisForUser.mockResolvedValue({
    resultJson: attachAnalysisSources(
      { red_flags: [{ evidence: { quote: "fee", segment: "full" } }] },
      id,
      "A fee applies.",
    ),
  });
});
describe("owner-scoped bounded source endpoint", () => {
  it("requires auth before IDs and queries; never accepts client owner IDs", async () => {
    auth.mockResolvedValue({ userId: null });
    expect((await get("?userId=owner")).status).toBe(401);
    expect(getContractSourceForUser).not.toHaveBeenCalled();
    auth.mockResolvedValue({ userId: "owner" });
    expect((await get("?userId=intruder")).status).toBe(400);
  });
  it("validates contract IDs before reading source data", async () => {
    const response = await GET(
      new Request("http://localhost/api/contracts/not-a-uuid/source"),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(response.status).toBe(404);
    expect(getContractSourceForUser).not.toHaveBeenCalled();
  });
  it("serves a bounded no-store page without requiring an analysis", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      text: "A fee applies.",
      offset: 0,
      nextOffset: null,
      previousOffset: null,
      highlight: null,
    });
    expect(getAnalysisForUser).not.toHaveBeenCalled();
    expect(getContractSourceForUser).toHaveBeenCalledWith({
      userId: "owner",
      contractId: id,
      offset: 0,
      revision: null,
    });
  });
  it.each([
    "?offset=-1",
    "?offset=NaN",
    "?offset=1.2",
    "?offset=1e3",
    "?offset=2147483647",
    "?offset=0&offset=1",
    "?limit=999999",
    "?revision=bad",
    "?flag=0",
    `?analysisId=${analysisId}`,
    `?analysisId=${analysisId}&flag=-1`,
    "?analysisId=bad&flag=0",
    `?analysisId=${analysisId}&flag=Jurisdiction`,
    `?analysisId=${analysisId}&flag=jurisdiction0`,
    `?analysisId=${analysisId}&flag=Notice`,
    `?analysisId=${analysisId}&flag=notice_citation`,
    `?analysisId=${analysisId}&flag=Renewal`,
    `?analysisId=${analysisId}&flag=renewal_citation`,
    `?analysisId=${analysisId}&flag=Payment`,
    `?analysisId=${analysisId}&flag=payments`,
    `?analysisId=${analysisId}&flag=payment_citation`,
  ])("rejects malformed/unbounded requests: %s", async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(getContractSourceForUser).not.toHaveBeenCalled();
  });
  it("highlights the governing-law quotation behind a jurisdiction proposal", async () => {
    const text = "Governed by the laws of Ontario.";
    const sourceRevision = contractSourceRevision(text);
    getContractSourceForUser.mockResolvedValue({
      revision: sourceRevision,
      text,
      totalCharacters: Array.from(text).length,
      extractionWarning: null,
      highlightMatches: true,
    });
    getAnalysisForUser.mockResolvedValue({
      resultJson: attachAnalysisSources(
        {
          proposed_jurisdiction: {
            jurisdiction: "Ontario",
            evidence: { quote: "laws of Ontario", segment: "full" },
          },
        },
        id,
        text,
      ),
    });
    const response = await get(
      `?revision=${sourceRevision}&analysisId=${analysisId}&flag=jurisdiction`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).highlight).toMatchObject({
      quote: "laws of Ontario",
      start: 16,
      end: 31,
    });
    // A report without a verified proposal has nothing to highlight.
    getAnalysisForUser.mockResolvedValue({
      resultJson: attachAnalysisSources(
        {
          proposed_jurisdiction: {
            jurisdiction: "Ontario",
            evidence: { quote: "laws of Quebec", segment: "full" },
          },
        },
        id,
        text,
      ),
    });
    expect(
      (
        await get(
          `?revision=${sourceRevision}&analysisId=${analysisId}&flag=jurisdiction`,
        )
      ).status,
    ).toBe(422);
  });
  it("highlights the clause stating the cancellation notice period", async () => {
    const text = "Either party may end this agreement on 10 business days' written notice.";
    const sourceRevision = contractSourceRevision(text);
    getContractSourceForUser.mockResolvedValue({
      revision: sourceRevision,
      text,
      totalCharacters: Array.from(text).length,
      extractionWarning: null,
      highlightMatches: true,
    });
    const analysed = (quote: string) =>
      attachAnalysisSources(
        {
          summary: {
            cancellation: {
              how: "Written notice",
              notice_period_days: null,
              notice_period_text: "10 business days",
              notice_evidence: { quote, segment: "full" },
            },
          },
        },
        id,
        text,
      );
    const notice = `?revision=${sourceRevision}&analysisId=${analysisId}&flag=notice`;
    getAnalysisForUser.mockResolvedValue({
      resultJson: analysed("on 10 business days' written notice"),
    });
    const response = await get(notice);
    expect(response.status).toBe(200);
    expect((await response.json()).highlight).toMatchObject({
      quote: "on 10 business days' written notice",
      start: 36,
      end: 71,
    });
    // A paraphrase is not verified, so there is nothing to highlight.
    getAnalysisForUser.mockResolvedValue({
      resultJson: analysed("ten business days of notice"),
    });
    expect((await get(notice)).status).toBe(422);
  });
  it("highlights the clause stating renewal", async () => {
    const text = "This agreement renews automatically for successive one-year terms.";
    const sourceRevision = contractSourceRevision(text);
    getContractSourceForUser.mockResolvedValue({
      revision: sourceRevision,
      text,
      totalCharacters: Array.from(text).length,
      extractionWarning: null,
      highlightMatches: true,
    });
    const analysed = (quote: string, autoRenew: boolean | null = true) =>
      attachAnalysisSources(
        {
          summary: {
            renewal: {
              auto_renew: autoRenew,
              renewal_period: null,
              renewal_evidence: { quote, segment: "full" },
            },
          },
        },
        id,
        text,
      );
    const renewal = `?revision=${sourceRevision}&analysisId=${analysisId}&flag=renewal`;
    getAnalysisForUser.mockResolvedValue({
      resultJson: analysed("renews automatically for successive one-year terms"),
    });
    const response = await get(renewal);
    expect(response.status).toBe(200);
    expect((await response.json()).highlight).toMatchObject({
      quote: "renews automatically for successive one-year terms",
      start: 15,
      end: 65,
    });
    // A paraphrase is not verified, and unknown renewal is never cited.
    for (const resultJson of [
      analysed("renews every year"),
      analysed("renews automatically for successive one-year terms", null),
    ]) {
      getAnalysisForUser.mockResolvedValue({ resultJson });
      expect((await get(renewal)).status).toBe(422);
    }
  });
  it("highlights the clause stating the payment amount and frequency", async () => {
    const text = "The Client pays a monthly fee of 1,200 GBP. Late payments accrue interest.";
    const sourceRevision = contractSourceRevision(text);
    getContractSourceForUser.mockResolvedValue({
      revision: sourceRevision,
      text,
      totalCharacters: Array.from(text).length,
      extractionWarning: null,
      highlightMatches: true,
    });
    const analysed = (quote: string, amount: string | null = "1,200 GBP") =>
      attachAnalysisSources(
        {
          summary: {
            payments: {
              amount,
              frequency: null,
              fees: [],
              payment_evidence: { quote, segment: "full" },
            },
          },
        },
        id,
        text,
      );
    const payment = `?revision=${sourceRevision}&analysisId=${analysisId}&flag=payment`;
    getAnalysisForUser.mockResolvedValue({
      resultJson: analysed("The Client pays a monthly fee of 1,200 GBP."),
    });
    const response = await get(payment);
    expect(response.status).toBe(200);
    expect((await response.json()).highlight).toMatchObject({
      quote: "The Client pays a monthly fee of 1,200 GBP.",
      start: 0,
      end: 43,
    });
    // A paraphrase is not verified, and unknown payment is never cited.
    for (const resultJson of [
      analysed("The Client pays 1,200 GBP monthly."),
      analysed("The Client pays a monthly fee of 1,200 GBP.", null),
    ]) {
      getAnalysisForUser.mockResolvedValue({ resultJson });
      expect((await get(payment)).status).toBe(422);
    }
  });
  it("returns the same 404 for missing, deleted, or unowned contracts", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getContractSourceForUser.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(getContractSourceForUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "intruder" }),
    );
  });
  it("does not return replacement text on a historical revision mismatch", async () => {
    getContractSourceForUser.mockResolvedValue({
      revision: contractSourceRevision("replacement"),
      text: null,
      totalCharacters: 11,
    });
    const response = await get(finding);
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain('"text"');
  });
  it("returns an honest empty state", async () => {
    getContractSourceForUser.mockResolvedValue({
      revision: contractSourceRevision(""),
      text: "",
      totalCharacters: 0,
      extractionWarning: null,
    });
    expect(await (await get()).json()).toMatchObject({
      text: "",
      totalCharacters: 0,
      nextOffset: null,
    });
  });
  it("paginates by Unicode code points and pins the expected revision", async () => {
    getContractSourceForUser.mockResolvedValue({
      revision,
      text: "😀".repeat(6000),
      totalCharacters: 20000,
      extractionWarning: "Scanned content missing",
    });
    const response = await get(`?offset=6000&revision=${revision}`);
    expect(await response.json()).toMatchObject({
      offset: 6000,
      nextOffset: 12000,
      previousOffset: 0,
      extractionWarning: "Scanned content missing",
    });
  });
  it("rejects past-the-end pages", async () => {
    expect((await get("?offset=14")).status).toBe(416);
  });
  it("returns only the server-verified saved finding as a highlight", async () => {
    const response = await get(finding);
    expect(await response.json()).toMatchObject({
      highlight: { quote: "fee", start: 2, end: 5, revision, contract_id: id },
    });
    expect(getAnalysisForUser).toHaveBeenCalledWith("owner", id, analysisId);
    expect(getContractSourceForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId,
        citation: expect.objectContaining({ quote: "fee" }),
      }),
    );
  });
  it("withholds highlights on other pages", async () => {
    getContractSourceForUser.mockResolvedValue({
      revision,
      text: "elsewhere",
      totalCharacters: 10000,
      extractionWarning: null,
      highlightMatches: true,
    });
    expect(await (await get(finding + "&offset=6000")).json()).toMatchObject({
      highlight: null,
    });
  });
  it("fails closed for legacy/forged reports without invalidating the report", async () => {
    getAnalysisForUser.mockResolvedValue({
      resultJson: {
        red_flags: [
          { where: "fee", citation: { status: "verified", quote: "fee" } },
        ],
      },
    });
    expect((await get(finding)).status).toBe(422);
    expect(getContractSourceForUser).not.toHaveBeenCalled();
  });
  it("does not navigate a deleted or unowned report", async () => {
    getAnalysisForUser.mockResolvedValue(null);
    expect((await get(finding)).status).toBe(404);
    expect(getContractSourceForUser).not.toHaveBeenCalled();
  });
  it("rechecks quote/range/coverage after reading the report", async () => {
    getContractSourceForUser.mockResolvedValue({
      revision,
      text: "A fee applies.",
      totalCharacters: 14,
      highlightMatches: false,
    });
    expect((await get(finding)).status).toBe(422);
  });
  it("handles report deletion between the two database reads", async () => {
    getContractSourceForUser.mockResolvedValue(null);
    expect((await get(finding)).status).toBe(404);
  });
});
