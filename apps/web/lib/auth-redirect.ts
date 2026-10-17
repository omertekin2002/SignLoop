// Vercel preview deployments have per-deployment hostnames, so no single
// NEXT_PUBLIC_WORKOS_REDIRECT_URI fits them. AuthKit's PKCE cookie is host-only,
// so the callback must return to the host that started sign-in.
// Production and local development keep the configured redirect URI.
export function previewRedirectUri(requestHost: string): string | undefined {
  if (process.env.VERCEL_ENV !== "preview") return undefined;
  // Only hostnames Vercel assigned to this deployment; never an arbitrary Host header.
  const hosts = [process.env.VERCEL_BRANCH_URL, process.env.VERCEL_URL].filter(
    (host): host is string => Boolean(host),
  );
  const host = hosts.find((candidate) => candidate === requestHost) ?? process.env.VERCEL_URL;
  return host ? `https://${host}/callback` : undefined;
}
