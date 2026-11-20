import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { json, unzip } from "../../lib/test-unzip";
import { expectNoCspViolations, recordCspViolations } from "../csp";
import { SIGNED_IN_ORIGIN } from "./env";

// Its own project, after the workspace project, because it adds a contract and a project the
// empty-account checks there must not see. It presses Settings' "Download my data" and reads the
// ZIP the browser saves, so the card's fetch and blob download, the streamed response, local object
// storage and the archive layout are all checked together.

test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.origin !== SIGNED_IN_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

const ROOT = "signloop-export";

type ExportedContract = {
  id: string;
  title: string;
  text: string | null;
  files: Array<{ fileName: string; contentType: string; sizeBytes: number; path: string | null }>;
  notes: { acceptanceReasons: string; openQuestions: string } | null;
};

test("Download my data saves a ZIP with the account's contract, note, project and settings", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  const violations = await recordCspViolations(page);
  const stamp = Date.now();

  // A text contract through the multipart upload path (no Blob token in this suite).
  const title = `E2E export lease ${stamp}`;
  const created = await page.request.post("/api/contracts", { data: { title } });
  expect(created.status()).toBe(201);
  const { id: contractId } = (await created.json()) as { id: string };
  const contractText = `This lease for export ${stamp} renews each year.\n\nEither party may end it with sixty days written notice.`;
  const contractBytes = Buffer.from(contractText);
  const upload = await page.request.post(`/api/contracts/${contractId}/upload`, {
    multipart: {
      file: { name: "e2e-export-lease.txt", mimeType: "text/plain", buffer: contractBytes },
    },
  });
  expect(upload.status()).toBe(200);

  const notes = {
    acceptanceReasons: `Export note ${stamp}: the rent is fair.`,
    openQuestions: "Who pays for repairs?",
  };
  const savedNotes = await page.request.put(`/api/contracts/${contractId}/notes`, {
    data: { ...notes, expectedUpdatedAt: null },
  });
  expect(savedNotes.status()).toBe(200);

  const projectTitle = `E2E export project ${stamp}`;
  const project = await page.request.post("/api/projects", { data: { title: projectTitle } });
  expect(project.status()).toBe(201);
  const { id: projectId } = (await project.json()) as { id: string };

  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  // The theme picker is enabled only on the client, so once it is, the button's click handler is
  // attached; a click before hydration would do nothing.
  await expect(page.getByRole("combobox", { name: "Theme" })).toBeEnabled();
  await expect(page.getByText("Loading settings...")).toHaveCount(0);
  const button = page.getByRole("button", { name: "Download my data" });
  await expect(button).toBeEnabled();

  const startedOn = new Date().toISOString().slice(0, 10);
  const downloading = page.waitForEvent("download");
  await button.click();
  const download = await downloading;
  await expect(page.getByText("Your data export has downloaded.")).toBeVisible();
  const finishedOn = new Date().toISOString().slice(0, 10);

  // The name carries the server's UTC date, which is the start or end date if the run spans midnight.
  const fileName = download.suggestedFilename();
  expect(fileName).toMatch(/^signloop-export-\d{4}-\d{2}-\d{2}\.zip$/);
  expect([startedOn, finishedOn]).toContain(fileName.slice("signloop-export-".length, -".zip".length));
  expect(await download.failure()).toBeNull();
  const entries = await unzip(await readFile(await download.path()));

  for (const name of ["README.txt", "contracts.json", "analyses.json", "projects.json", "chats.json", "settings.json"]) {
    expect(entries.has(`${ROOT}/${name}`), `${ROOT}/${name} is in the archive`).toBe(true);
  }
  expect(entries.get(`${ROOT}/README.txt`)!.toString("utf8")).toContain("SignLoop data export");

  const contracts = json(entries, `${ROOT}/contracts.json`) as ExportedContract[];
  const contract = contracts.find((entry) => entry.id === contractId);
  expect(contract, "the new contract is in contracts.json").toBeDefined();
  expect(contract).toMatchObject({ title, text: contractText, notes });
  expect(contract!.files).toHaveLength(1);
  const [file] = contract!.files;
  expect(file).toMatchObject({
    fileName: "e2e-export-lease.txt",
    contentType: "text/plain",
    sizeBytes: contractBytes.length,
  });
  expect(file!.path).toMatch(new RegExp(`^files/contracts/${contractId}/`));
  const stored = entries.get(`${ROOT}/${file!.path}`);
  expect(stored, "the contract's path points to a file in the archive").toBeDefined();
  expect(stored!.equals(contractBytes), "the archived file holds the uploaded bytes").toBe(true);

  const projects = json(entries, `${ROOT}/projects.json`) as Array<{ id: string; title: string }>;
  expect(projects).toContainEqual(expect.objectContaining({ id: projectId, title: projectTitle }));

  // null until the account changes a setting; otherwise the saved model and personality.
  const settings = json(entries, `${ROOT}/settings.json`);
  if (settings !== null) {
    expect(settings).toHaveProperty("primaryModel");
    expect(settings).toHaveProperty("personality");
  }
  expect(Array.isArray(json(entries, `${ROOT}/analyses.json`))).toBe(true);
  expect(Array.isArray(json(entries, `${ROOT}/chats.json`))).toBe(true);

  expect(pageErrors).toEqual([]);
  expectNoCspViolations(violations, "settings while downloading the export");
});
