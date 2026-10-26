import { queryOptions } from "@tanstack/react-query";
import { apiClient, ApiRequestError } from "@/lib/api-client";
import type { ChatToolActivity } from "@/lib/chat";
import type { AnalysisResult } from "@/lib/schemas";

export type AnalysisRecord = {
  id: string;
  riskBadge?: string | null;
  resultJson?: Partial<AnalysisResult> | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  createdAt?: string | Date | null;
};

export type ContractDetail = {
  analysesHasMore?: boolean;
  title?: string | null;
  status?: string | null;
  /** Quality warning for the current extracted text; absent when extraction was clean. */
  extractionWarning?: string | null;
  /** The jurisdiction the owner confirmed; analyses run afterwards may include comparisons. */
  confirmedJurisdiction?: string | null;
  jurisdictionConfirmedAt?: string | Date | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  analyses?: AnalysisRecord[] | null;
};

export interface ProjectDetail {
  contractsHasMore: boolean;
  contextHasMore: boolean;
  id: string;
  title: string;
  description?: string;
  status: string;
  createdAt: string;
  contracts: Array<{
    id: string;
    title: string;
    status: string;
    createdAt: string;
    analyses?: Array<{ id: string; riskBadge: string }>;
  }>;
  contextDocuments: Array<{
    id: string;
    title: string;
    documentType: string;
    originalFilename?: string;
    fileSize?: number;
    wordCount?: number;
    createdAt: string;
  }>;
}

export type ChatThreadMessage = {
  files?: import("@/lib/chat-files-shared").ChatFileInfo[];
  toolActivity?: ChatToolActivity[];
  id: string;
  position: number;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
  model?: string | null;
  provider?: string | null;
};

export type ChatThreadDetail = {
  id: string;
  title: string;
  messages: ChatThreadMessage[];
  hasMore: boolean;
};

// Inherit freshness/retry policy from the identity-scoped QueryClient for both
// destination observers and intent prefetches. Never seed these from list summaries.
export function contractDetailOptions(id: string) {
  return queryOptions({
    queryKey: ["contract", id],
    queryFn: async ({ signal }) =>
      (await apiClient.get<ContractDetail>(`/contracts/${id}`, { signal })).data,
  });
}

export function projectDetailOptions(id: string, contractsOffset = 0, contextOffset = 0) {
  return queryOptions({
    queryKey: ["project", id, contractsOffset, contextOffset],
    queryFn: async ({ signal }) =>
      (await apiClient.get<ProjectDetail>(
        `/projects/${id}?contractsOffset=${contractsOffset}&contextOffset=${contextOffset}`,
        { signal },
      )).data,
  });
}

export function chatThreadOptions(id: string | null) {
  return queryOptions({
    queryKey: ["chat-thread", id],
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/chat/threads/${id}`, { signal });
      const payload = (await response.json().catch(() => null)) as {
        data?: ChatThreadDetail;
        error?: string;
      } | null;

      if (!response.ok || !payload?.data) {
        throw new ApiRequestError(payload?.error || "Failed to fetch chat thread.", response.status);
      }

      return payload.data;
    },
  });
}
