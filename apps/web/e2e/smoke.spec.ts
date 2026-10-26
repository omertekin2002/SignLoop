import { expect, test } from "@playwright/test";
import { E2E_ORIGIN, E2E_REDIRECT_URI, E2E_WORKOS_CLIENT_ID } from "./placeholder-env";

// Keep the browser on the local server: a regression that redirects a public page to WorkOS, or
// a new third-party request, fails here instead of depending on the network.
test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.origin !== E2E_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
});

test("the landing page renders and runs its client bundle without errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("SignLoop");
  await expect(page.locator('textarea[aria-label="Chat message"]')).toBeVisible();
  // The hero heading's visible copy is typed out on the client (the server renders it empty, with
  // the full text only in an sr-only span), so seeing all of it proves hydration ran.
  await expect(page.locator('h1 span[aria-hidden="true"]').first()).toContainText("Not guesswork.");
  expect(pageErrors).toEqual([]);
});

test("the privacy policy is public", async ({ page, request }) => {
  const direct = await request.get("/privacy", { maxRedirects: 0 });
  expect(direct.status()).toBe(200);

  const response = await page.goto("/privacy");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  // Account deletion is self-serve in Settings, not a public GitHub issue.
  const deletion = page.locator("p", { hasText: "To delete your account entirely" });
  await expect(deletion.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  await expect(deletion).not.toContainText("GitHub");
  // So is getting a copy of your data.
  const copy = page.locator("p", { hasText: "To download everything in your account" });
  await expect(copy.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
});

test("responses carry the security headers from next.config.js", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toBe("camera=(), geolocation=(), microphone=()");
});

for (const path of ["/dashboard", "/sign-in"]) {
  test(`unauthenticated ${path} redirects to WorkOS sign-in`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    expect([302, 303, 307]).toContain(response.status());

    const location = new URL(response.headers()["location"] ?? "", E2E_ORIGIN);
    expect(location.origin).toBe("https://api.workos.com");
    expect(location.pathname).toBe("/user_management/authorize");
    expect(location.searchParams.get("client_id")).toBe(E2E_WORKOS_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(E2E_REDIRECT_URI);
  });
}

for (const path of ["/api/usage", "/api/contracts", "/api/account/export"]) {
  test(`unauthenticated GET ${path} returns a JSON 401`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
}

test("unauthenticated DELETE /api/account returns a JSON 401", async ({ request }) => {
  const response = await request.delete("/api/account", {
    data: { confirm: "DELETE" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});
