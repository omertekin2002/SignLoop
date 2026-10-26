import { expect, test as setup } from "@playwright/test";
import { AUTH_STATE_PATH, SIGNED_IN_ORIGIN, signedInEnv } from "./env";

// The full sign-in loop: /sign-in, AuthKit's hosted page, /callback (which maps the WorkOS user to
// a new workspace in the empty database), then the dashboard. Later projects reuse the session.
setup("sign in with email and password through AuthKit", async ({ page }) => {
  const { E2E_USER_EMAIL, E2E_USER_PASSWORD } = signedInEnv();

  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\.authkit\.app\//);
  await page.getByRole("textbox", { name: "Email" }).fill(E2E_USER_EMAIL);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByRole("textbox", { name: "Password" }).fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The first callback also applies every migration to the empty database.
  await page.waitForURL(`${SIGNED_IN_ORIGIN}/dashboard`, { timeout: 45_000 });

  // A new account must accept the privacy notice before using the workspace. The acceptance lives
  // in localStorage, which the saved state carries to the later projects.
  const notice = page.getByRole("alertdialog", { name: "SignLoop Privacy Notice" });
  await notice.getByRole("button", { name: "I Understand and Accept" }).click();
  await expect(notice).toBeHidden();
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
