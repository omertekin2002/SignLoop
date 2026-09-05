"use client";

import { uploadContract } from "@/lib/upload-contract";

import { useState, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { formatFileSize } from "@/lib/utils";
import {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILE_SIZE_MB,
} from "@/lib/upload-constants";
import { Upload, File, Loader2 } from "lucide-react";

interface UploadDialogProps {
  children: React.ReactNode;
}

export function UploadDialog({ children }: UploadDialogProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [contractName, setContractName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      // Default contract name to filename without extension
      setContractName(selectedFile.name.replace(/\.[^/.]+$/, ""));
    }
  };

  const uploadMutation = useMutation({
    mutationFn: () => uploadContract({ file, title: contractName }),
    onSuccess: (result) => {
      if (result.warning) {
        toast.warning(`Contract uploaded. ${result.warning}`);
      } else {
        toast.success("Contract uploaded successfully");
      }
      setOpen(false);
      setFile(null);
      setContractName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
    },
    onError: (error: unknown) => {
      toast.error(getApiErrorMessage(error, "Upload failed"));
    },
  });

  const handleUpload = () => {
    if (!file || !contractName.trim()) return;
    // Fail fast on oversize files before the two-step network flow creates an orphan contract.
    if (file.size > MAX_UPLOAD_FILE_SIZE) {
      toast.error(
        `File too large. Maximum size is ${MAX_UPLOAD_FILE_SIZE_MB} MB.`,
      );
      return;
    }
    uploadMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
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
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="file">Contract File</Label>
            <button
              type="button"
              className="flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors hover:bg-muted/50"
              onClick={() => fileInputRef.current?.click()}
              aria-label={
                file
                  ? `Change selected file: ${file.name}`
                  : "Select a contract file"
              }
            >
              {file ? (
                <div className="text-center">
                  <File className="h-8 w-8 mx-auto text-primary mb-2" />
                  <p className="text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                  </p>
                </div>
              ) : (
                <div className="text-center">
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm font-medium">Click to select file</p>
                  <p className="text-xs text-muted-foreground">
                    PDF, DOC, DOCX, TXT, or images up to{" "}
                    {MAX_UPLOAD_FILE_SIZE_MB}MB
                  </p>
                </div>
              )}
            </button>
            <input
              ref={fileInputRef}
              id="file"
              type="file"
              accept=".pdf,.txt,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.tif,.tiff"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={handleUpload}
            disabled={!file || !contractName.trim() || uploadMutation.isPending}
          >
            {uploadMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
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
