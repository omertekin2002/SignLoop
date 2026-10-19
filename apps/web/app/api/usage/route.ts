import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getInferenceQuota } from "@/lib/server-db";
import {
  INFERENCE_POLICY,
  rateLimitHeaders,
  type UsageResponse,
} from "@/lib/inference-policy";

const NO_STORE = { "Cache-Control": "private, no-store" };

// Reports the signed-in account's shared chat/analysis quota. Reading it never claims any.
export async function GET() {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) {
    authed.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return authed;
  }
  try {
    const { account, service } = await getInferenceQuota(authed.userId);
    const body: UsageResponse = {
      account,
      shared: INFERENCE_POLICY.shared,
      service,
    };
    return NextResponse.json(body, {
      headers: { ...NO_STORE, ...rateLimitHeaders(account) },
    });
  } catch (error) {
    console.error("Usage lookup failed:", error);
    return NextResponse.json(
      { error: "Usage is temporarily unavailable. Please try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }
}
