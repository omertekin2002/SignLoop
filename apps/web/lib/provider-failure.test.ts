import { describe, expect, it } from "vitest";
import { safeProviderFailureMetadata } from "./provider-failure";

describe("safeProviderFailureMetadata", () => {
  it("keeps only allowlisted machine-readable fields", () => {
    const providerError = Object.assign(
      new Error("private prompt primary-key https://primary.test/v1 upstream body"),
      {
        name: "NotFoundError",
        status: 404,
        code: "model_not_found",
        requestID: "req_safe123",
        responseBody: "private provider body",
        requestBodyValues: { input: "contract text" },
      },
    );

    const metadata = safeProviderFailureMetadata(
      "primary-openai-compatible",
      "primary/model",
      providerError,
    );

    expect(metadata).toEqual({
      provider: "primary-openai-compatible",
      model: "primary/model",
      errorClass: "NotFoundError",
      statusCode: 404,
      providerCode: "model_not_found",
      upstreamRequestId: "req_safe123",
    });
    const serialized = JSON.stringify(metadata);
    for (const secret of ["private prompt", "primary-key", "https://primary.test/v1", "private provider body", "contract text"])
      expect(serialized).not.toContain(secret);
  });

  it("reads nested codes and request IDs from response headers", () => {
    expect(
      safeProviderFailureMetadata(
        "openrouter",
        "fallback/model",
        Object.assign(new Error("failure"), {
          statusCode: 503,
          error: { code: "overloaded" },
          headers: new Headers({ "x-request-id": "req-header-1" }),
        }),
      ),
    ).toEqual({
      provider: "openrouter",
      model: "fallback/model",
      errorClass: "Error",
      statusCode: 503,
      providerCode: "overloaded",
      upstreamRequestId: "req-header-1",
    });
  });

  it("drops values that are not safe machine identifiers", () => {
    const metadata = safeProviderFailureMetadata(
      "openrouter",
      "fallback/model",
      Object.assign(new Error("failure"), {
        name: "Bad name with spaces",
        status: 999,
        code: "code with spaces",
        request_id: "id\nwith-newline",
      }),
    );
    expect(metadata).toEqual({
      provider: "openrouter",
      model: "fallback/model",
      errorClass: "Error",
    });
    expect(safeProviderFailureMetadata("openrouter", "m", "raw string error")).toEqual({
      provider: "openrouter",
      model: "m",
      errorClass: "string",
    });
  });
});
