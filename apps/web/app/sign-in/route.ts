import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  // A Route Handler lets AuthKit set the flow-specific PKCE cookie before redirecting.
  const response = NextResponse.redirect(await getSignInUrl({ returnTo: "/dashboard" }));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}
