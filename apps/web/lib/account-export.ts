import { ExportArchive } from "@/lib/export-archive";
import { readObject } from "@/lib/object-storage";
import {
  getChatFileForUser,
  getChatImageForUser,
  type AccountExportData,
} from "@/lib/server-db";

export const EXPORT_ROOT = "signloop-export";

/** `signloop-export-<UTC date>.zip`, the download's file name. */
export function exportFileName(exportedAt: Date): string {
  return `${EXPORT_ROOT}-${exportedAt.toISOString().slice(0, 10)}.zip`;
}

function readme(exportedAt: Date, missing: string[], unlinked: string[]): string {
  const lines = [
    "SignLoop data export",
    `Exported: ${exportedAt.toISOString()}`,
    "",
    "contracts.json   Your contracts with their extracted text, uploaded files and your notes",
    "                 (null if you never wrote any).",
    "analyses.json    Every analysis of those contracts, by contractId.",
    "projects.json    Your projects with their reference documents and extracted text.",
    "chats.json       Your saved chats with their messages, files and images.",
    "settings.json    Your model and personality settings (null if you never changed them).",
    "",
    "files/contracts/<contract id>/   Original contract uploads.",
    "files/projects/<project id>/     Original project reference documents.",
    "files/chats/<chat id>/           Files and generated images from saved chats.",
    "",
    'Each "path" in the JSON files points to the file in this archive. Files are exactly as',
    "they were stored. File names were made safe for every system, and repeated names were",
    'numbered, as in "contract (2).pdf".',
  ];
  if (unlinked.length) {
    lines.push("", "Uploaded contract files no longer linked to a contract:", ...unlinked.map((path) => `  ${path}`));
  }
  if (missing.length) {
    lines.push(
      "",
      "These files were deleted or could not be found while the export was made:",
      ...missing.map((path) => `  ${path}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Group rows by thread, dropping the now-implied threadId. */
function groupByThread<T extends { threadId: string }>(rows: T[]): Map<string, Omit<T, "threadId">[]> {
  const groups = new Map<string, Omit<T, "threadId">[]>();
  for (const { threadId, ...row } of rows) {
    const group = groups.get(threadId) ?? [];
    group.push(row);
    groups.set(threadId, group);
  }
  return groups;
}

/**
 * Lay out one owner's data as the export ZIP and return it as a stream. JSON documents name each
 * file's archive path; stored objects and chat bytes are read only as the stream reaches them.
 */
export function createAccountExport(input: {
  userId: string;
  data: AccountExportData;
  exportedAt: Date;
  signal?: AbortSignal;
}): ReadableStream<Uint8Array> {
  const { userId, data, exportedAt, signal } = input;
  const archive = new ExportArchive(EXPORT_ROOT);
  const stored = (storageKey: string) => () => readObject(storageKey, signal);

  const filesByContract = new Map<string, unknown[]>();
  const unlinked: string[] = [];
  for (const file of data.contractFiles) {
    const path = file.storageKey
      ? archive.addFile(["files", "contracts", file.contractId ?? "unlinked"], file.fileName, stored(file.storageKey))
      : null;
    if (!file.contractId) {
      if (path) unlinked.push(path);
      continue;
    }
    const files = filesByContract.get(file.contractId) ?? [];
    files.push({
      id: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      extractionMethod: file.extractionMethod,
      extractionConfidence: file.extractionConfidence,
      uploadedAt: file.createdAt,
      path,
    });
    filesByContract.set(file.contractId, files);
  }

  const notesByContract = new Map(
    data.contractNotes.map(({ contractId, ...notes }) => [contractId, notes]),
  );

  const documentsByProject = new Map<string, unknown[]>();
  for (const { storageKey, projectId, ...document } of data.contextDocuments) {
    const path = storageKey
      ? archive.addFile(
          ["files", "projects", projectId],
          document.originalFilename || document.title,
          stored(storageKey),
        )
      : null;
    const documents = documentsByProject.get(projectId) ?? [];
    documents.push({ ...document, path });
    documentsByProject.set(projectId, documents);
  }

  const messages = groupByThread(data.chatMessages);
  const chatFiles = groupByThread(data.chatFiles);
  const chatImages = groupByThread(data.chatImages);
  const chats = data.chatThreads.map((thread) => ({
    ...thread,
    messages: messages.get(thread.id) ?? [],
    files: (chatFiles.get(thread.id) ?? []).map((file) => ({
      ...file,
      path: archive.addFile(["files", "chats", thread.id], file.filename, async () =>
        (await getChatFileForUser(userId, thread.id, file.id))?.data ?? null,
      ),
    })),
    images: (chatImages.get(thread.id) ?? []).map((image) => ({
      ...image,
      // Chat images are the PNGs that image generation returned.
      path: archive.addFile(["files", "chats", thread.id], `${image.id}.png`, () =>
        getChatImageForUser(userId, thread.id, image.id),
      ),
    })),
  }));

  return archive.stream({
    modifiedAt: exportedAt,
    documents: {
      "contracts.json": data.contracts.map(({ textContent, ...contract }) => ({
        ...contract,
        text: textContent,
        files: filesByContract.get(contract.id) ?? [],
        notes: notesByContract.get(contract.id) ?? null,
      })),
      "analyses.json": data.analyses,
      "projects.json": data.projects.map((project) => ({
        ...project,
        contextDocuments: documentsByProject.get(project.id) ?? [],
      })),
      "chats.json": chats,
      "settings.json": data.settings,
    },
    readme: (missing) => readme(exportedAt, missing, unlinked),
  });
}
