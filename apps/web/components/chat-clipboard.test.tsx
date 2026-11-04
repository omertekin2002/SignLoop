import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { chatAttachmentAdapter } from "@/lib/chat-files-client";
import { pasteChatFiles } from "@/lib/chat-clipboard";

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error } }));
const run = vi.fn(async function* () {
  yield { content: [{ type: "text" as const, text: "Answer" }] };
});
const model: ChatModelAdapter = { run };
function AttachmentName() {
  return (
    <AttachmentPrimitive.Root>
      <AttachmentPrimitive.Name />
    </AttachmentPrimitive.Root>
  );
}
function Composer({ canAttach = true, disabled = false }) {
  const attachments = useMemo(chatAttachmentAdapter, []);
  const runtime = useLocalRuntime(model, { adapters: { attachments } });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input
          aria-label="Chat message"
          disabled={disabled}
          addAttachmentOnPaste={false}
          onPaste={(event) =>
            pasteChatFiles(
              event,
              (file) => runtime.thread.composer.addAttachment(file),
              canAttach && !disabled,
            )
          }
        />
        <ComposerPrimitive.Attachments
          components={{ Attachment: AttachmentName }}
        />
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
beforeEach(() => vi.clearAllMocks());

it("pastes an image and document into the real composer once without sending", async () => {
  render(<Composer />);
  const files = [
    new File(["image"], "screenshot.png", { type: "image/png" }),
    new File(["pdf"], "contract.pdf", { type: "application/pdf" }),
  ];
  expect(
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        files,
        items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      },
    }),
  ).toBe(false);
  expect(await screen.findByText("screenshot.png")).toBeVisible();
  expect(await screen.findByText("contract.pdf")).toBeVisible();
  expect(screen.getAllByText("contract.pdf")).toHaveLength(1);
  expect(run).not.toHaveBeenCalled();
});

it("supports clipboard items without a file list and supplies a usable filename", async () => {
  render(<Composer />);
  const file = new File(["pdf"], "", { type: "application/pdf" });
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: { items: [{ kind: "file", getAsFile: () => file }] },
  });
  expect(await screen.findByText("pasted-file-1.pdf")).toBeVisible();
});

it("retains the existing draft when pasted files exceed the attachment limit", async () => {
  render(<Composer />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Review these files" } });
  fireEvent.paste(input, {
    clipboardData: {
      files: Array.from(
        { length: 5 },
        (_, i) => new File(["text"], `file-${i}.txt`),
      ),
    },
  });
  await waitFor(() =>
    expect(error).toHaveBeenCalledWith(
      "Attach at most four files per message.",
    ),
  );
  expect(screen.getByText("file-3.txt")).toBeVisible();
  expect(screen.queryByText("file-4.txt")).toBeNull();
  expect(input).toHaveValue("Review these files");
});

it("keeps plain Ctrl+V text paste working", async () => {
  const user = userEvent.setup();
  render(<Composer />);
  const input = screen.getByRole("textbox");
  await user.click(input);
  await user.paste("Explain this renewal clause.");
  expect(input).toHaveValue("Explain this renewal clause.");
  expect(run).not.toHaveBeenCalled();
});

it.each([{ canAttach: false }, { disabled: true }])(
  "does not stage pasted files when attachment access is disabled (%o)",
  async (props) => {
    render(<Composer {...props} />);
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [new File(["pdf"], "contract.pdf")] },
    });
    await Promise.resolve();
    expect(screen.queryByText("contract.pdf")).toBeNull();
  },
);
