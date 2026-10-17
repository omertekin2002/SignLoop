import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextFetchEvent, NextRequest } from "next/server";
import { previewRedirectUri } from "@/lib/auth-redirect";

const middlewareAuth = {
  enabled: true,
  // API handlers enforce their own JSON 401 responses. Chat also supports anonymous
  // temporary requests, and the cleanup cron authenticates with its bearer secret.
  unauthenticatedPaths: ["/", "/privacy", "/api/:path*", "/callback", "/sign-in/:path*", "/sign-up/:path*"],
};

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // An undefined redirectUri keeps AuthKit's NEXT_PUBLIC_WORKOS_REDIRECT_URI default.
  // The proxy forwards it to getSignInUrl()/getSignUpUrl() through x-redirect-uri.
  return authkitProxy({
    middlewareAuth,
    redirectUri: previewRedirectUri(request.nextUrl.host),
  })(request, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
