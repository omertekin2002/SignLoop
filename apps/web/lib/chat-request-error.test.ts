import { expect, it } from "vitest";
import { chatRequestFailure } from "./chat-request-error";

it("gives an expired WorkOS session an actionable sign-in message", () => {
  expect(
    chatRequestFailure({ error: "Unauthorized" }, 401, null).message,
  ).toMatch(/Sign in/);
});
it("preserves safe rejection details and Retry-After seconds or HTTP dates", () => {
  const now = Date.UTC(2026, 9, 18);
  expect(
    chatRequestFailure({ error: "Shared quota reached" }, 429, "30", now),
  ).toEqual({
    message: "Shared quota reached",
    status: 429,
    retryAt: now + 30_000,
  });
  expect(
    chatRequestFailure(null, 429, new Date(now + 60_000).toUTCString(), now)
      .retryAt,
  ).toBe(now + 60_000);
  expect(chatRequestFailure(null, 409, null, now).message).toMatch(
    /already running/,
  );
  expect(chatRequestFailure(null, 500, "invalid", now).retryAt).toBe(now);
});
