import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, claimGenerationOperation, admitChat } = vi.hoisted(() => ({
  auth: vi.fn(),
  claimGenerationOperation: vi.fn(),
  admitChat: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({ claimGenerationOperation }));
vi.mock("@/lib/chat-admission", () => ({ admitChat }));
vi.mock("@/lib/telemetry", () => ({
  isTelemetryEnabled: false,
  flushTelemetry: vi.fn(),
}));

import { POST } from "@/app/api/chat/route";

afterEach(() => {
  auth.mockReset();
  claimGenerationOperation.mockReset();
  admitChat.mockReset();
});

describe("saved chat admission", () => {
  it("does not charge admission for a busy thread", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    claimGenerationOperation.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "11e3e947-f71f-4ecd-a901-adbf24edbb8a",
          messages: [{ role: "user", content: "What does this mean?" }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(claimGenerationOperation).toHaveBeenCalledOnce();
    expect(admitChat).not.toHaveBeenCalled();
  });
});
