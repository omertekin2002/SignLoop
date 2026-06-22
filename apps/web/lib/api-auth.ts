import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Shared auth + body-parsing helpers for API route handlers, so every route enforces a
// consistent 401 shape and tolerates malformed JSON bodies without copy-pasting the guard.

// Returns the authenticated userId, or a 401 NextResponse the caller should early-return.
// Usage:
//   const authed = await requireUserId();
//   if (authed instanceof NextResponse) return authed;
//   const { userId } = authed;
export async function requireUserId(): Promise<{ userId: string } | NextResponse> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { userId };
}

// Parse a JSON request body, returning null on empty/invalid JSON so handlers can respond
// with a clean 400 instead of throwing an unhandled 500.
export async function parseJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
