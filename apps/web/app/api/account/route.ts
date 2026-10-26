import { after, NextResponse } from "next/server";
import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { ACCOUNT_DELETION_CONFIRMATION } from "@/lib/account-deletion";
import { parseJsonBody } from "@/lib/api-auth";
import { authWithWorkOSUser } from "@/lib/auth";
import { deleteAccountForUser } from "@/lib/server-db";
import { flushStorageDeletions } from "@/lib/storage-cleanup";

function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

// Deletes the signed-in account: every owned row first, then the WorkOS user, then the session.
// Data goes first so a WorkOS failure leaves an empty, signed-in workspace the user can retry
// from, never data without a login. A retry maps the session to a fresh, empty owner, deletes it,
// and tries WorkOS again; a user WorkOS no longer has counts as deleted.
export async function DELETE(req: Request) {
  const identity = await authWithWorkOSUser();
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await parseJsonBody<{ confirm?: unknown }>(req);
  if (body?.confirm !== ACCOUNT_DELETION_CONFIRMATION) {
    return NextResponse.json(
      { error: `Confirm account deletion with {"confirm":"${ACCOUNT_DELETION_CONFIRMATION}"}` },
      { status: 400 },
    );
  }

  try {
    await deleteAccountForUser(identity.userId);
  } catch (error) {
    console.error("Failed to delete account data:", error);
    return NextResponse.json({ error: "Failed to delete account" }, { status: 500 });
  }
  after(() => flushStorageDeletions().then(() => {}));

  try {
    await getWorkOS().userManagement.deleteUser(identity.workosUserId);
  } catch (error) {
    if (!isNotFound(error)) {
      console.error("Failed to delete WorkOS user:", error);
      return NextResponse.json(
        {
          error:
            "Your data was deleted, but your sign-in could not be removed. Please try again.",
        },
        { status: 502 },
      );
    }
  }

  // End the session the way AuthKit's signOut does: expire its cookie. The user no longer exists
  // at WorkOS, so there is no session to log out of there.
  const response = NextResponse.json({ deleted: true });
  response.cookies.delete({
    name: process.env.WORKOS_COOKIE_NAME || "wos-session",
    path: "/",
    domain: process.env.WORKOS_COOKIE_DOMAIN || undefined,
  });
  return response;
}
