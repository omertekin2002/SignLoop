import { describe, expect, it, vi } from "vitest";
import { ExportArchive, sanitizeArchiveSegment } from "@/lib/export-archive";
import { json, unzip } from "@/lib/test-unzip";

const modifiedAt = new Date("2026-10-26T12:00:00Z");
const readme = (missing: string[]) => `README\n${missing.join("\n")}`;

function chunked(bytes: Uint8Array, size: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

describe("sanitizeArchiveSegment", () => {
  it.each([
    ["../evil.pdf", "_evil.pdf"],
    ["..", "file"],
    [".", "file"],
    ["", "file"],
    ["/etc/passwd", "_etc_passwd"],
    ["C:\\Windows\\system.ini", "C__Windows_system.ini"],
    ["a<b>c:d\"e|f?g*h", "a_b_c_d_e_f_g_h"],
    ["tab\there\nnew", "tab_here_new"],
    ["  spaced   out.pdf  ", "spaced out.pdf"],
    ["trailing dots...", "trailing dots"],
    ["CON", "_CON"],
    ["nul.txt", "_nul.txt"],
    ["Sözleşme.pdf", "Sözleşme.pdf"],
  ])("%j becomes %j", (input, expected) => {
    expect(sanitizeArchiveSegment(input)).toBe(expected);
  });

  it("bounds long names and keeps the extension", () => {
    const name = sanitizeArchiveSegment(`${"x".repeat(500)}.pdf`);
    expect(name).toHaveLength(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("ExportArchive", () => {
  it("lays out JSON documents, files and the README under one root folder, byte-identical", async () => {
    const binary = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31) % 256);
    const archive = new ExportArchive("signloop-export");
    const streamed = archive.addFile(["files", "contracts", "c1"], "lease.pdf", async () => chunked(binary, 4096));
    const buffered = archive.addFile(["files", "chats", "t1"], "notes.txt", async () => new TextEncoder().encode("Notes"));
    const unicode = archive.addFile(["files", "projects", "p1"], "Sözleşme.docx", async () => Uint8Array.of(1, 2, 3));

    expect([streamed, buffered, unicode]).toEqual([
      "files/contracts/c1/lease.pdf",
      "files/chats/t1/notes.txt",
      "files/projects/p1/Sözleşme.docx",
    ]);

    const entries = await unzip(
      archive.stream({ modifiedAt, documents: { "contracts.json": [{ id: "c1" }], "settings.json": null }, readme }),
    );

    expect([...entries.keys()]).toEqual([
      "signloop-export/contracts.json",
      "signloop-export/settings.json",
      "signloop-export/files/contracts/c1/lease.pdf",
      "signloop-export/files/chats/t1/notes.txt",
      "signloop-export/files/projects/p1/Sözleşme.docx",
      "signloop-export/README.txt",
    ]);
    expect(json(entries, "signloop-export/contracts.json")).toEqual([{ id: "c1" }]);
    expect(json(entries, "signloop-export/settings.json")).toBeNull();
    expect(entries.get("signloop-export/files/contracts/c1/lease.pdf")!.equals(Buffer.from(binary))).toBe(true);
    expect(entries.get("signloop-export/files/chats/t1/notes.txt")!.toString()).toBe("Notes");
    expect([...entries.get("signloop-export/files/projects/p1/Sözleşme.docx")!]).toEqual([1, 2, 3]);
    expect(entries.get("signloop-export/README.txt")!.toString()).toBe("README\n");
  });

  it("sanitizes traversal names and numbers duplicates, case-insensitively", async () => {
    const archive = new ExportArchive("signloop-export");
    const open = async () => new TextEncoder().encode("x");
    const paths = [
      archive.addFile(["files", "contracts", "c1"], "../evil.pdf", open),
      archive.addFile(["files", "contracts", "c1"], "../../evil.pdf", open),
      archive.addFile(["files", "contracts", "c1"], "/abs/../../evil.pdf", open),
      archive.addFile(["files", "contracts", "c1"], "contract.pdf", open),
      archive.addFile(["files", "contracts", "c1"], "contract.pdf", open),
      archive.addFile(["files", "contracts", "c1"], "CONTRACT.pdf", open),
      archive.addFile(["files", "contracts", "c2"], "contract.pdf", open),
      archive.addFile(["files", "..", "c1"], "readme", open),
    ];

    expect(paths).toEqual([
      "files/contracts/c1/_evil.pdf",
      "files/contracts/c1/_.._evil.pdf",
      "files/contracts/c1/_abs_.._.._evil.pdf",
      "files/contracts/c1/contract.pdf",
      "files/contracts/c1/contract (2).pdf",
      "files/contracts/c1/CONTRACT (3).pdf",
      "files/contracts/c2/contract.pdf",
      "files/folder/c1/readme",
    ]);

    const entries = await unzip(archive.stream({ modifiedAt, documents: {}, readme }));
    expect(entries.size).toBe(paths.length + 1);
    for (const name of entries.keys()) {
      expect(name.startsWith("signloop-export/")).toBe(true);
      expect(name.split("/")).not.toContain("..");
      expect(name).not.toMatch(/\\/);
    }
  });

  it("writes a valid archive with only the documents and README for an empty workspace", async () => {
    const archive = new ExportArchive("signloop-export");
    const entries = await unzip(
      archive.stream({ modifiedAt, documents: { "contracts.json": [], "chats.json": [] }, readme }),
    );
    expect([...entries.keys()]).toEqual([
      "signloop-export/contracts.json",
      "signloop-export/chats.json",
      "signloop-export/README.txt",
    ]);
    expect(json(entries, "signloop-export/contracts.json")).toEqual([]);
  });

  it("leaves out files whose source is gone and lists them in the README", async () => {
    const archive = new ExportArchive("signloop-export");
    archive.addFile(["files"], "gone.pdf", async () => null);
    archive.addFile(["files"], "kept.pdf", async () => Uint8Array.of(7));
    const entries = await unzip(archive.stream({ modifiedAt, documents: {}, readme }));
    expect([...entries.keys()]).toEqual(["signloop-export/files/kept.pdf", "signloop-export/README.txt"]);
    expect(entries.get("signloop-export/README.txt")!.toString()).toBe("README\nfiles/gone.pdf");
  });

  it("reads each source only when the stream reaches it", async () => {
    const archive = new ExportArchive("signloop-export");
    const first = vi.fn(async () => Uint8Array.of(1));
    const second = vi.fn(async () => Uint8Array.of(2));
    archive.addFile(["files"], "a", first);
    archive.addFile(["files"], "b", second);
    const reader = archive.stream({ modifiedAt, documents: {}, readme }).getReader();
    expect(first).not.toHaveBeenCalled();
    while (!first.mock.calls.length) await reader.read();
    expect(second).not.toHaveBeenCalled();
    await reader.cancel();
  });

  it("cancels the current source when the download is abandoned", async () => {
    const cancel = vi.fn();
    const archive = new ExportArchive("signloop-export");
    archive.addFile(["files"], "endless.bin", async () =>
      new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(new Uint8Array(1024)),
        cancel,
      }),
    );
    const reader = archive.stream({ modifiedAt, documents: {}, readme }).getReader();
    for (let read = 0; read < 5; read += 1) await reader.read();
    await reader.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("fails the stream when a source fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const archive = new ExportArchive("signloop-export");
    archive.addFile(["files"], "broken.pdf", async () => {
      throw new Error("storage unavailable");
    });
    await expect(unzip(archive.stream({ modifiedAt, documents: {}, readme }))).rejects.toThrow("storage unavailable");
    vi.restoreAllMocks();
  });
});
