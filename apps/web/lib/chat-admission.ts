import { NextResponse } from "next/server";
import { claimChatAdmission } from "@/lib/server-db";
import {
  admissionLimits,
  rateLimitHeaders,
  type AdmissionRejection,
  type AdmissionResult,
} from "@/lib/inference-policy";

/** Shared chat/analysis quota under INFERENCE_POLICY. userId is the stable application owner
 * resolved from WorkOS. Only accounts receive their quota; the shared anonymous bucket is never
 * reported. Keep the existing CHAT_* configuration names for deployment compatibility.
 */
async function admitInference(userId: string | null): Promise<AdmissionResult> {
  const result = await claimChatAdmission(admissionLimits(userId));
  if (!userId) delete result.quota;
  return result;
}

export const admitChat = admitInference;
export function admitAnalysis(userId: string) {
  return admitInference(userId);
}

/** A rejected claim as a 429. Retry-After is always set; quota and RateLimit fields only for accounts. */
export function admissionRejectedResponse(
  rejection: AdmissionRejection,
  error: string,
): NextResponse {
  const { retryAfter, reason, resetAt, quota } = rejection;
  return NextResponse.json(
    { error, reason, resetAt, ...(quota ? { quota } : {}) },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        ...rateLimitHeaders(quota),
      },
    },
  );
}
