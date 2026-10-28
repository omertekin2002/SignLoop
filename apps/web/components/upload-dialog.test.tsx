import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UploadDialog } from "@/components/upload-dialog";
import type { UploadConfig } from "@/lib/upload-client";

const mocks = vi.hoisted(() => ({
  uploadContract: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const uploadConfig: UploadConfig = {
  directUpload: null,
  maxFileSizeBytes: 10 * 1024 * 1024,
};

vi.mock("@/lib/upload-contract", () => ({ uploadContract: mocks.uploadContract }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
// Serve GET /api/uploads from memory; formatUploadLimit and the rest stay real.
vi.mock("@/lib/upload-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/upload-client")>()),
  uploadConfigOptions: () =>
    queryOptions({
      queryKey: ["upload-config"],
      staleTime: Infinity,
      queryFn: async () => uploadConfig,
    }),
}));

const PROMPT = "Drag and drop or click to select file";

function makeFile(name: string, size: number, type = "application/pdf") {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function filesTransfer(files: File[]) {
  return { dataTransfer: { types: ["Files"], files, dropEffect: "none" } };
}

async function openDialog() {
  const user = userEvent.setup({ applyAccept: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <UploadDialog>
        <button type="button">Open upload</button>
      </UploadDialog>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Open upload" }));
  const dialog = await screen.findByRole("dialog", { name: "Upload Contract" });
  // Selection checks the size limit only once the config has loaded.
  await screen.findByText(/up to 10 MB/);
  return {
    user,
    dialog,
    fileInput: screen.getByLabelText("Contract File"),
    nameInput: screen.getByLabelText("Contract Name"),
    uploadButton: screen.getByRole("button", { name: "Upload Contract" }),
  };
}

describe("UploadDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the upload limit from the upload config", async () => {
    await openDialog();
    expect(
      screen.getByText("PDF, DOC, DOCX, TXT, or images up to 10 MB"),
    ).toBeInTheDocument();
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
  });

  it("selects a file picked through the input and prefills the contract name", async () => {
    const { user, fileInput, nameInput } = await openDialog();
    await user.upload(fileInput, makeFile("Office Lease.v2.pdf", 2048));

    expect(screen.getByText("Office Lease.v2.pdf")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
    expect(nameInput).toHaveValue("Office Lease.v2");
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("rejects an unsupported file type and keeps the previous selection", async () => {
    const { user, fileInput, nameInput } = await openDialog();
    await user.upload(fileInput, makeFile("lease.pdf", 2048));
    await user.upload(fileInput, makeFile("payload.exe", 2048, "application/octet-stream"));

    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Unsupported file type. Choose a PDF, DOC, DOCX, TXT, or supported image file.",
    );
    expect(screen.getByText("lease.pdf")).toBeInTheDocument();
    expect(screen.queryByText("payload.exe")).not.toBeInTheDocument();
    expect(nameInput).toHaveValue("lease");
  });

  it("rejects a file over the size limit and keeps the previous selection", async () => {
    const { user, fileInput, nameInput } = await openDialog();
    await user.upload(fileInput, makeFile("lease.pdf", 2048));
    await user.upload(fileInput, makeFile("huge.pdf", uploadConfig.maxFileSizeBytes + 1));

    expect(mocks.toast.error).toHaveBeenCalledWith(
      "File too large. Maximum size is 10 MB.",
    );
    expect(screen.getByText("lease.pdf")).toBeInTheDocument();
    expect(screen.queryByText("huge.pdf")).not.toBeInTheDocument();
    expect(nameInput).toHaveValue("lease");
  });

  it("accepts a file exactly at the size limit", async () => {
    const { user, fileInput } = await openDialog();
    await user.upload(fileInput, makeFile("max.pdf", uploadConfig.maxFileSizeBytes));

    expect(screen.getByText("max.pdf")).toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("rejects a multi-file drop and keeps the previous selection", async () => {
    const { user, dialog, fileInput, nameInput } = await openDialog();
    await user.upload(fileInput, makeFile("lease.pdf", 2048));
    fireEvent.drop(
      dialog,
      filesTransfer([makeFile("a.pdf", 10), makeFile("b.pdf", 10)]),
    );

    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Please select one contract file at a time.",
    );
    expect(screen.getByText("lease.pdf")).toBeInTheDocument();
    expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
    expect(nameInput).toHaveValue("lease");
  });

  it("shows the drop prompt while dragging and selects a dropped file", async () => {
    const { dialog, nameInput } = await openDialog();

    fireEvent.dragEnter(dialog, filesTransfer([]));
    expect(screen.getByText("Drop file here")).toBeInTheDocument();
    fireEvent.dragLeave(dialog, filesTransfer([]));
    expect(screen.queryByText("Drop file here")).not.toBeInTheDocument();
    expect(screen.getByText(PROMPT)).toBeInTheDocument();

    fireEvent.dragEnter(dialog, filesTransfer([]));
    fireEvent.drop(dialog, filesTransfer([makeFile("Supplier NDA.docx", 512)]));
    expect(screen.queryByText("Drop file here")).not.toBeInTheDocument();
    expect(screen.getByText("Supplier NDA.docx")).toBeInTheDocument();
    expect(screen.getByText("512 B")).toBeInTheDocument();
    expect(nameInput).toHaveValue("Supplier NDA");
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("disables upload without a file or with a blank name", async () => {
    const { user, fileInput, nameInput, uploadButton } = await openDialog();
    expect(uploadButton).toBeDisabled();

    await user.type(nameInput, "Office lease");
    expect(uploadButton).toBeDisabled();

    await user.upload(fileInput, makeFile("lease.pdf", 2048));
    expect(uploadButton).toBeEnabled();

    await user.clear(nameInput);
    expect(uploadButton).toBeDisabled();
    await user.type(nameInput, "   ");
    expect(uploadButton).toBeDisabled();
    await user.click(uploadButton);
    expect(mocks.uploadContract).not.toHaveBeenCalled();
  });

  it("uploads the file with the entered name and config, then closes and resets", async () => {
    mocks.uploadContract.mockResolvedValue({ success: true });
    const { user, fileInput, nameInput, uploadButton } = await openDialog();
    const file = makeFile("lease.pdf", 2048);
    await user.upload(fileInput, file);
    await user.clear(nameInput);
    // The dialog passes the name as entered; uploadContract trims it before creating the contract.
    await user.type(nameInput, "  Office lease  ");
    await user.click(uploadButton);

    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        "Contract uploaded successfully",
      ),
    );
    expect(mocks.uploadContract).toHaveBeenCalledTimes(1);
    expect(mocks.uploadContract).toHaveBeenCalledWith(
      expect.objectContaining({
        file,
        title: "  Office lease  ",
        config: uploadConfig,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Open upload" }));
    await screen.findByRole("dialog", { name: "Upload Contract" });
    expect(screen.getByLabelText("Contract Name")).toHaveValue("");
    expect(screen.queryByText("lease.pdf")).not.toBeInTheDocument();
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload Contract" })).toBeDisabled();
  });

  it("shows the API error message when the upload fails", async () => {
    mocks.uploadContract.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 413"), {
        response: { data: { error: "Contract quota reached." } },
      }),
    );
    const { user, fileInput, uploadButton } = await openDialog();
    await user.upload(fileInput, makeFile("lease.pdf", 2048));
    await user.click(uploadButton);

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith("Contract quota reached."),
    );
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Upload Contract" })).toBeInTheDocument();
    expect(screen.getByText("lease.pdf")).toBeInTheDocument();
  });
});
