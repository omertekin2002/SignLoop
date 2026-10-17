import "server-only";

import { withAuth } from "@workos-inc/authkit-nextjs";
import { resolveWorkOSUserId } from "@/lib/auth-identity";

// Route handlers use the application's stable owner ID, never an ID supplied by a client.
// Anonymous requests do not touch the database, so temporary chat remains public.
export async function auth(): Promise<{ userId: string | null }> {
  const { user } = await withAuth();
  return { userId: user ? await resolveWorkOSUserId(user) : null };
}
