import { handleAuth } from "@workos-inc/authkit-nextjs";
import { resolveWorkOSUserId } from "@/lib/auth-identity";

export const GET = handleAuth({
  returnPathname: "/dashboard",
  // Complete the personal identity mapping before entering the workspace. AuthKit
  // clears the session if this fails, allowing a clean retry after a database outage.
  onSuccess: async ({ user }) => {
    await resolveWorkOSUserId(user);
  },
  onError: async () => Response.json({ error: "Unable to sign in. Please try again." }, { status: 400 }),
});
