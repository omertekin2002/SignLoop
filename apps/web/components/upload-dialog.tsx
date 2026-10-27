"use client";

import { useOperationProgress, isOperationCanceled } from "@/lib/use-operation-progress";
import { OperationStatus } from "@/components/operation-status";

import { uploadContract } from "@/lib/upload-contract";

import { useState, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-client";
import { cn, formatFileSize } from "@/lib/utils";
import { formatUploadLimit, uploadConfigOptions } from "@/lib/upload-client";
import { Upload, File, Loader2 } from "lucide-react";

const ACCEPTED_FILE_TYPES = ".pdf,.txt,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.tif,.tiff";

interface UploadDialogProps {
  children: React.ReactNode;
}

export function UploadDialog({ children }: UploadDialogProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [contractName, setContractName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const operation = useOperationProgress("upload-dialog");
  const queryClient = useQueryClient();
  const { data: uploadConfig } = useQuery({
    ...uploadConfigOptions(),
    enabled: open,
  });

  const resetDrag = () => {
    dragDepth.current = 0;
    setIsDragging(false);
  };

  const uploadMutation = useMutation({
    mutationFn: () =>
      operation.run("creating", async (options) =>
        uploadContract({
          file,
          title: contractName,
          config: await queryClient.fetchQuery(uploadConfigOptions()),
          ...options,
        }),
      ),
    onSuccess: (result) => {
      if (result.warning) {
        toast.warning(`Contract uploaded. ${result.warning}`);
      } else {
        toast.success("Contract uploaded successfully");
      }
      setOpen(false);
      resetDrag();
      setFile(null);
      setContractName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
    },
    onError: (error: unknown) => {
      if (isOperationCanceled(error)) return;
      toast.error(getApiErrorMessage(error, "Upload failed"));
    },
  });

  const selectFiles = (files: FileList | null) => {
    if (uploadMutation.isPending || !files?.length) return;
    if (files.length > 1) {
      toast.error("Please select one contract file at a time.");
      return;
    }
    const selectedFile = files[0];
    if (!selectedFile) return;
    const extension = selectedFile.name.slice(selectedFile.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED_FILE_TYPES.split(",").includes(extension)) {
      toast.error("Unsupported file type. Choose a PDF, DOC, DOCX, TXT, or supported image file.");
      return;
    }
    if (uploadConfig && selectedFile.size > uploadConfig.maxFileSizeBytes) {
      toast.error(`File too large. Maximum size is ${formatUploadLimit(uploadConfig)}.`);
      return;
    }
    setFile(selectedFile);
    // Default contract name to filename without extension.
    setContractName(selectedFile.name.replace(/\.[^/.]+$/, ""));
  };

  const handleUpload = () => {
    if (!file || !contractName.trim() || uploadMutation.isPending) return;
    // Fail fast on oversize files; uploadContract checks again if the limit was still loading.
    if (uploadConfig && file.size > uploadConfig.maxFileSizeBytes) {
      toast.error(
        `File too large. Maximum size is ${formatUploadLimit(uploadConfig)}.`,
      );
      return;
    }
    uploadMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) {
        operation.cancel();
        resetDrag();
      }
      setOpen(next);
    }}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="sm:max-w-[425px]"
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          if (!uploadMutation.isPending) setIsDragging(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = uploadMutation.isPending ? "none" : "copy";
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setIsDragging(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          resetDrag();
          selectFiles(event.dataTransfer.files);
        }}
      >
        <DialogHeader>
          <DialogTitle>Upload Contract</DialogTitle>
          <DialogDescription>
            Upload a PDF, Word document, image, or text file to start analysis.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Contract Name</Label>
            <Input
              id="name"
              value={contractName}
              onChange={(e) => setContractName(e.target.value)}
              placeholder="e.g. Employment Agreement"
              disabled={uploadMutation.isPending}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="file">Contract File</Label>
            <button
              type="button"
              className={cn(
                "flex w-full cursor-pointer flex-col items-center justify-center rounded-card border border-dashed p-6 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                isDragging
                  ? "border-primary bg-primary/10"
                  : "border-input hover:border-primary/60 hover:bg-foreground/[0.03]",
              )}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              {file && !isDragging ? (
                <div className="text-center">
                  <File className="h-8 w-8 mx-auto text-primary mb-2" />
                  <p className="text-sm font-medium">
                    <span className="sr-only">Change selected file: </span>
                    {file.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                  </p>
                </div>
              ) : (
                <div className="text-center">
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm font-medium">
                    {isDragging ? "Drop file here" : "Drag and drop or click to select file"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    PDF, DOC, DOCX, TXT, or images
                    {uploadConfig
                      ? ` up to ${formatUploadLimit(uploadConfig)}`
                      : ""}
                  </p>
                </div>
              )}
            </button>
            <input
              ref={fileInputRef}
              id="file"
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              className="hidden"
              disabled={uploadMutation.isPending}
              onChange={(event) => {
                selectFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </div>
        </div>
        <OperationStatus stage={operation.stage} />
        <DialogFooter>
          <Button
            onClick={handleUpload}
            disabled={!file || !contractName.trim() || uploadMutation.isPending}
          >
            {uploadMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Working…
              </>
            ) : (
              "Upload Contract"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
