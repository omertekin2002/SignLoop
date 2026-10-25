import { expect, it, vi } from "vitest";
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
import { chatAttachmentAdapter } from "./chat-files-client";
import type { PendingAttachment } from "@assistant-ui/react";

it("limits the draft to four files and restores capacity after removal or send", async () => {
  const adapter = chatAttachmentAdapter();
  const add = () =>
    adapter.add({
      file: new File(["Private notes"], "notes.txt", { type: "text/plain" }),
    }) as Promise<PendingAttachment>;
  const files = await Promise.all([add(), add(), add(), add()]);
  await expect(add()).rejects.toThrow("four files");
  await adapter.remove(files[0]!);
  const replacement = await add();
  expect((await adapter.send(replacement)).status.type).toBe("complete");
  await expect(add()).resolves.toHaveProperty("name", "notes.txt");
});
