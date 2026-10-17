import { authkitProxy } from "@workos-inc/authkit-nextjs";

export default authkitProxy({
  middlewareAuth: {
    enabled: true,
    // API handlers enforce their own JSON 401 responses. Chat also supports anonymous
    // temporary requests, and the cleanup cron authenticates with its bearer secret.
    unauthenticatedPaths: ["/", "/api/:path*", "/callback", "/sign-in/:path*", "/sign-up/:path*"],
  },
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
