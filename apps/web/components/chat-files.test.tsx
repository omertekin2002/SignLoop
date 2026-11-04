import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ComposerFile, UploadedFile } from "./chat-files";

const { attachment, createObjectURL, revokeObjectURL } = vi.hoisted(() => ({
  attachment: {
    current: {} as {
      name: string;
      contentType: string;
      file?: File;
      content?: Array<{ type: string; text: string }>;
    },
  },
  createObjectURL: vi.fn(() => "blob:thumbnail"),
  revokeObjectURL: vi.fn(),
}));
vi.mock("@assistant-ui/react", () => ({
  useAttachment: () => attachment.current,
  AttachmentPrimitive: {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Name: () => <span>{attachment.current.name}</span>,
    Remove: ({ children }: { children: ReactNode }) => children,
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it("previews a selected image and releases its object URL on removal", () => {
  attachment.current = {
    name: "photo.png",
    contentType: "image/png",
    file: new File(["png"], "photo.png", { type: "image/png" }),
  };
  const { unmount } = render(<ComposerFile />);
  expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute(
    "src",
    "blob:thumbnail",
  );
  expect(screen.getByRole("button", { name: "Remove file" })).toBeVisible();
  unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail");
});

it("restores a saved image preview using only an owner-checked file URL", () => {
  const url =
    "/api/chat/threads/11111111-1111-4111-8111-111111111111/files/22222222-2222-4222-8222-222222222222";
  attachment.current = {
    name: "photo.png",
    contentType: "image/png",
    content: [{ type: "text", text: url }],
  };
  render(<UploadedFile />);
  expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute(
    "src",
    url,
  );
  expect(screen.getByRole("link")).toHaveAttribute("href", url);
});

it("does not load an arbitrary remote attachment preview", () => {
  attachment.current = {
    name: "photo.png",
    contentType: "image/png",
    content: [{ type: "text", text: "https://external.test/tracker.png" }],
  };
  render(<UploadedFile />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
