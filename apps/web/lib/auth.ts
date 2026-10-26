import "server-only";

import { withAuth } from "@workos-inc/authkit-nextjs";
import { DeletedAuthIdentityError, resolveWorkOSUserId } from "@/lib/auth-identity";

// Route handlers use the application's stable owner ID, never an ID supplied by a client.
// Anonymous requests do not touch the database, so temporary chat remains public.
export async function auth(): Promise<{ userId: string | null }> {
  const identity = await authWithWorkOSUser();
  return { userId: identity?.userId ?? null };
}

// Account deletion also needs the session's WorkOS user ID, to remove the login after the data.
export async function authWithWorkOSUser(): Promise<{
  userId: string;
  workosUserId: string;
} | null> {
  const { user } = await withAuth();
  if (!user) return null;
  try {
    return { userId: await resolveWorkOSUserId(user), workosUserId: user.id };
  } catch (error) {
    if (error instanceof DeletedAuthIdentityError) return null;
    throw error;
  }
}
