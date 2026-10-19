import { expect, it } from "vitest";
import { chatRequestFailure } from "./chat-request-error";
import { formatResetTime } from "./usage-client";

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

const resetAt = "2026-10-19T15:00:00.000Z";
const quota = {
  limit: 30,
  used: 30,
  remaining: 0,
  resetAt,
  concurrency: { limit: 2, inUse: 0 },
};
const now = Date.parse(resetAt) - 1_200_000;

it("words hourly and daily rejections with the local reset time and keeps the quota", () => {
  const hourly = chatRequestFailure(
    {
      error: "Chat is at its hourly request limit.",
      reason: "hourly",
      resetAt,
      quota,
    },
    429,
    "1207",
    now,
  );
  expect(hourly).toEqual({
    message: `You've used all 30 requests this hour, shared by chat and analysis. They reset at ${formatResetTime(resetAt, now)}.`,
    status: 429,
    retryAt: now + 1_207_000,
    reason: "hourly",
    resetAt,
    quota,
  });
  // Anonymous rejections carry no quota, so the message cannot name the limit.
  expect(
    chatRequestFailure({ reason: "hourly", resetAt }, 429, "1207", now),
  ).toMatchObject({
    message: `The hourly request limit has been reached. It resets at ${formatResetTime(resetAt, now)}.`,
    reason: "hourly",
  });
  expect(
    chatRequestFailure({ reason: "daily", resetAt }, 429, "1207", now).message,
  ).toBe(
    `SignLoop has reached its daily request limit. Please try again after ${formatResetTime(resetAt, now)}.`,
  );
});

it("keeps the server's wording for busy rejections and ignores malformed or non-429 reasons", () => {
  const busy = "Chat is busy with other replies. Please try again shortly.";
  expect(
    chatRequestFailure(
      { error: busy, reason: "busy", resetAt },
      429,
      "37",
      now,
    ),
  ).toEqual({
    message: busy,
    status: 429,
    retryAt: now + 37_000,
    reason: "busy",
    resetAt,
  });
  expect(
    chatRequestFailure(
      { error: "Limited", reason: "weekly", resetAt },
      429,
      "5",
      now,
    ),
  ).toEqual({ message: "Limited", status: 429, retryAt: now + 5_000 });
  expect(
    chatRequestFailure(
      { error: "Limited", reason: "hourly", resetAt: "soon" },
      429,
      null,
      now,
    ).message,
  ).toBe("Limited");
  expect(
    chatRequestFailure(
      { error: "Broken", reason: "hourly", resetAt },
      500,
      null,
      now,
    ),
  ).toEqual({ message: "Broken", status: 500, retryAt: now });
});
