import { describe, expect, it, vi } from "vitest";
import { clipboardFiles, pasteChatFiles } from "./chat-clipboard";

function clipboard(
  files: File[],
  items: Array<{ kind: string; getAsFile(): File | null }> = [],
): DataTransfer {
  return { files, items } as unknown as DataTransfer;
}

describe("clipboard files", () => {
  it("reads image and document files once when both clipboard representations contain them", () => {
    const image = new File(["image"], "screenshot.png", { type: "image/png" });
    const document = new File(["pdf"], "contract.pdf", {
      type: "application/pdf",
    });
    const files = [image, document];
    expect(
      clipboardFiles(
        clipboard(
          files,
          files.map((file) => ({ kind: "file", getAsFile: () => file })),
        ),
      ),
    ).toEqual(files);
  });

  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
    ["application/pdf", "pdf"],
    ["text/plain", "txt"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
    ],
  ])(
    "names an unnamed %s file from clipboard items",
    async (type, extension) => {
      const file = new File(["clipboard bytes"], "", { type });
      const result = clipboardFiles(
        clipboard([], [{ kind: "file", getAsFile: () => file }]),
      );
      expect(result[0]?.name).toBe(`pasted-file-1.${extension}`);
      expect(result[0]?.type).toBe(type);
      expect(await result[0]?.text()).toBe("clipboard bytes");
    },
  );

  it("does not manufacture attachments from plain text, URLs, or local file paths", () => {
    expect(clipboardFiles(null)).toEqual([]);
    expect(
      clipboardFiles(
        clipboard(
          [],
          [
            { kind: "string", getAsFile: () => null },
            { kind: "file", getAsFile: () => null },
          ],
        ),
      ),
    ).toEqual([]);
  });
});

describe("chat paste", () => {
  it("stages every file without submitting or inserting the accompanying clipboard text", async () => {
    const files = [new File(["pdf"], "one.pdf"), new File(["text"], "two.txt")];
    const add = vi
      .fn()
      .mockRejectedValueOnce(new Error("Invalid file"))
      .mockResolvedValue(undefined);
    const preventDefault = vi.fn();
    pasteChatFiles(
      { clipboardData: clipboard(files), preventDefault },
      add,
      true,
    );
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(add.mock.calls).toEqual(files.map((file) => [file]));
  });

  it.each([false, true])(
    "leaves text paste untouched (attachment access=%s)",
    (enabled) => {
      const preventDefault = vi.fn();
      const add = vi.fn();
      pasteChatFiles(
        { clipboardData: clipboard([]), preventDefault },
        add,
        enabled,
      );
      expect(preventDefault).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    },
  );

  it("respects disabled or signed-out composers", () => {
    const add = vi.fn();
    const preventDefault = vi.fn();
    pasteChatFiles(
      {
        clipboardData: clipboard([new File(["png"], "image.png")]),
        preventDefault,
      },
      add,
      false,
    );
    expect(add).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
