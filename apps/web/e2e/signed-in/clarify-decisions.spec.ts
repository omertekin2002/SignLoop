import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectNoA11yViolations, startInTheme } from "../axe";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import { STUB_ANALYSIS_FLAGS, STUB_CONTRACT_FIXTURE } from "../stub-model-server";
import { uploadThroughDashboard } from "./dashboard";
import { SIGNED_IN_ORIGIN } from "./env";

// Its own project, after the workspace project, because it adds an analysed contract with a
// decision. The app's model is the local stub (e2e/stub-model-server.ts), which answers every
// analysis of the fixture with the same report, so a re-run on unchanged text lists the same items
// under the same keys and source revision.

test.beforeEach(async ({ context }) => {
  // The stub is reached by the server, never by the page.
  await context.route(
    (url) => url.origin !== SIGNED_IN_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

const FIXTURE_TEXT = readFileSync(STUB_CONTRACT_FIXTURE, "utf8").trim();
const REASON = "Agreed with the provider: renewal needs our written yes.";

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function analyzeResponse(page: Page, id: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/contracts/${id}/analyze`,
  );
}

function decisionsResponse(page: Page, id: string, method: "PUT" | "DELETE") {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname.startsWith(`/api/contracts/${id}/decisions`),
  );
}

type StoredDecision = { id: string; analysisId: string | null; state: string; reason: string; itemLabel: string };

async function storedDecisions(page: Page, id: string): Promise<StoredDecision[]> {
  const response = await page.request.get(`/api/contracts/${id}/decisions`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { decisions: StoredDecision[] }).decisions;
}

async function analysisIds(page: Page, id: string): Promise<string[]> {
  const response = await page.request.get(`/api/contracts/${id}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { analyses: { id: string }[] }).analyses.map((each) => each.id);
}

test("a decision on a Before you sign item survives a reload and a re-analysis, and can be removed", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  const violations = await recordCspViolations(page);
  await startInTheme(page, "dark");
  const stamp = Date.now();
  const title = `E2E decisions agreement ${stamp}`;
  const id = await uploadThroughDashboard(
    page,
    title,
    `${FIXTURE_TEXT}\n\nAgreement reference: E2E-DECIDE-${stamp}.\n`,
  );

  await page.goto(`/contracts/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const analysed = analyzeResponse(page, id);
  await page.getByRole("button", { name: "Start Analysis" }).click();
  expect((await analysed).status()).toBe(200);
  const checklist = page.getByRole("region", { name: "Before you sign: what to clarify" });
  await expect(checklist).toBeVisible({ timeout: 30_000 });
  const [firstAnalysis] = await analysisIds(page, id);

  const [flag] = STUB_ANALYSIS_FLAGS;
  const name = `finding: ${flag.type}`;
  const item = checklist
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: flag.type, exact: true }) });
  const askLinks = async () =>
    checklist.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  const linksBefore = await askLinks();

  // Record: choose a state, give a reason, save.
  await checklist.getByRole("button", { name: `Record decision on ${name}`, exact: true }).click();
  const form = checklist.getByRole("form", { name: `Your decision on ${name}` });
  await form.getByRole("radio", { name: "Accepted" }).check();
  await form.getByLabel(`Reason for your decision on ${name}`).fill(REASON);
  await expectNoA11yViolations(page, { theme: "dark" });
  const saved = decisionsResponse(page, id, "PUT");
  await form.getByRole("button", { name: `Save decision on ${name}` }).click();
  expect((await saved).status()).toBe(200);
  await expect(item).toContainText(REASON);
  await expect(item).toContainText("Accepted");
  await expect(form).toHaveCount(0);
  // Saving changes neither the items nor their links.
  expect(await askLinks()).toEqual(linksBefore);
  expect(await storedDecisions(page, id)).toMatchObject([
    { analysisId: firstAnalysis, state: "accepted", reason: REASON, itemLabel: `Finding: ${flag.type}` },
  ]);

  // It is still there after a reload.
  await page.reload();
  await expect(item).toContainText(REASON);
  await expectNoA11yViolations(page, { theme: "dark" });

  // Re-run the analysis on the same text: the new analysis lists the same item, and the decision
  // stays on it rather than moving to the earlier group.
  const rerun = analyzeResponse(page, id);
  await page.getByRole("button", { name: "Re-run Analysis" }).click();
  expect((await rerun).status()).toBe(200);
  await expect.poll(async () => (await analysisIds(page, id)).length).toBe(2);
  await page.reload();
  await expect(item).toContainText(REASON);
  await expect(item).toContainText("Accepted");
  await expect(checklist.getByText(/Decisions from earlier analyses/)).toHaveCount(0);
  const [decision] = await storedDecisions(page, id);
  // Saved on the first analysis and shown on the second, by key and source revision alone.
  expect(decision!.analysisId).toBe(firstAnalysis);

  // The light theme, with the saved decision on screen.
  await startInTheme(page, "light");
  await page.reload();
  await expect(item).toContainText(REASON);
  await expectNoA11yViolations(page, { theme: "light" });

  // Remove it.
  const removed = decisionsResponse(page, id, "DELETE");
  await checklist.getByRole("button", { name: `Remove decision on ${name}`, exact: true }).click();
  expect((await removed).status()).toBe(200);
  await expect(
    checklist.getByRole("button", { name: `Record decision on ${name}`, exact: true }),
  ).toBeVisible();
  await expect(item).not.toContainText(REASON);
  expect(await storedDecisions(page, id)).toEqual([]);
  await page.reload();
  await expect(
    checklist.getByRole("button", { name: `Record decision on ${name}`, exact: true }),
  ).toBeVisible();

  expectNoCspViolations(violations, "a contract page with decisions");
  expect(pageErrors).toEqual([]);
});
