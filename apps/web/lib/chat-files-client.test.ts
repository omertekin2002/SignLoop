import { afterEach, expect, it, vi } from "vitest";
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
import { chatAttachmentAdapter, uploadChatFile } from "./chat-files-client";
import { chatImage } from "./fixtures/chat-image";
import type { PendingAttachment } from "@assistant-ui/react";
afterEach(() => vi.unstubAllGlobals());

it("stages images with their type and uploads visual bytes without document text", async () => {
  const adapter = chatAttachmentAdapter();
  const file = new File([Buffer.from(chatImage.data, "base64")], chatImage.name, { type: "image/png" });
  const attachment = await adapter.add({ file }) as PendingAttachment;
  expect(attachment).toMatchObject({ type: "image", contentType: "image/png", name: chatImage.name });
  const fetch = vi.fn().mockResolvedValue(Response.json({ file: chatImage }));
  vi.stubGlobal("fetch", fetch);
  expect(await uploadChatFile(file, null, new AbortController().signal)).toEqual(chatImage);
  const submitted = fetch.mock.calls[0]![1].body.get("file");
  expect(Buffer.from(await submitted.arrayBuffer()).toString("base64")).toBe(chatImage.data);
});

it("rejects unsupported images and mixed file batches over the existing limit", async () => {
  const adapter = chatAttachmentAdapter();
  const add = (name: string) => adapter.add({ file: new File(["bytes"], name) }) as Promise<PendingAttachment>;
  await expect(add("image.svg")).rejects.toThrow("PNG, JPEG, or WebP");
  await expect(add("image.heic")).rejects.toThrow("PNG, JPEG, or WebP");
  await add("one.png"); await add("two.jpg"); await add("three.txt"); await add("four.docx");
  await expect(add("five.webp")).rejects.toThrow("four files");
});

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
