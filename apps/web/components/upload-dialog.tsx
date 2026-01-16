import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { apiClient } from "@/lib/api-client";
import { Upload, File, Loader2 } from "lucide-react";

interface UploadDialogProps {
    children: React.ReactNode;
}

export function UploadDialog({ children }: UploadDialogProps) {
    const [open, setOpen] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [contractName, setContractName] = useState("");
    const [uploading, setUploading] = useState(false);
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

    const handleUpload = async () => {
        if (!file || !contractName) return;

        setUploading(true);
        try {
            // 1. Create Contract
            const createRes = await apiClient.post("/contracts", {
                title: contractName,
            });
            const contractId = createRes.data.id;

            // 2. Upload File
            const formData = new FormData();
            formData.append("file", file);

            await apiClient.post(`/contracts/${contractId}/upload`, formData, {
                headers: {
                    "Content-Type": "multipart/form-data",
                },
            });

            toast.success("Contract uploaded successfully");
            setOpen(false);
            setFile(null);
            setContractName("");
            queryClient.invalidateQueries({ queryKey: ["contracts"] });
        } catch (error: any) {
            console.error(error);
            toast.error(error.response?.data?.message || "Upload failed");
        } finally {
            setUploading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>{children}</DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Upload Contract</DialogTitle>
                    <DialogDescription>
                        Upload a PDF or image of your contract to start analysis.
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
                        <div
                            className="border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center cursor-pointer hover:bg-muted/50 transition-colors"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {file ? (
                                <div className="text-center">
                                    <File className="h-8 w-8 mx-auto text-primary mb-2" />
                                    <p className="text-sm font-medium">{file.name}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {(file.size / 1024 / 1024).toFixed(2)} MB
                                    </p>
                                </div>
                            ) : (
                                <div className="text-center">
                                    <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                                    <p className="text-sm font-medium">Click to select file</p>
                                    <p className="text-xs text-muted-foreground">PDF or Images up to 10MB</p>
                                </div>
                            )}
                            <input
                                ref={fileInputRef}
                                id="file"
                                type="file"
                                accept=".pdf,image/*,.txt,.doc,.docx"
                                className="hidden"
                                onChange={handleFileChange}
                            />
                        </div>
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        onClick={handleUpload}
                        disabled={!file || !contractName || uploading}
                    >
                        {uploading ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Uploading...
                            </>
                        ) : (
                            "Upload and Analyze"
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
