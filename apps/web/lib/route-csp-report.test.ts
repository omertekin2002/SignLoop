import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { POST } from "@/app/api/csp-report/route";

const MAX_BYTES = 16 * 1024;

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const report = (body: BodyInit, contentType: string) =>
  new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });

const logged = () => warn.mock.calls.map((call) => call.map(String).join(" "));

const reportUriBody = {
  "csp-report": {
    "document-uri": "https://signloop.example/contracts/abc?token=secret#section",
    referrer: "https://signloop.example/dashboard?q=private",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'; report-uri /api/csp-report",
    disposition: "report",
    "blocked-uri": "https://cdn.evil.example/payload.js?session=secret",
    "script-sample": "alert('private contract text')",
    "status-code": 200,
  },
};

describe("POST /api/csp-report", () => {
  it("logs a report-uri report as one line, reduced to directive, origin and path", async () => {
    const response = await POST(report(JSON.stringify(reportUriBody), "application/csp-report"));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(logged()).toEqual([
      "CSP violation: directive=script-src-elem blocked=https://cdn.evil.example page=/contracts/abc",
    ]);
    const output = logged().join("\n");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("private");
    expect(output).not.toContain("?");
  });

  it("logs each violation of a Reporting API batch and skips other report types", async () => {
    const body = [
      {
        type: "csp-violation",
        age: 10,
        url: "https://signloop.example/settings?tab=usage",
        user_agent: "Chrome",
        body: {
          documentURL: "https://signloop.example/settings?tab=usage",
          blockedURL: "inline",
          effectiveDirective: "style-src-attr",
          originalPolicy: "default-src 'self'",
          disposition: "report",
          sample: "color: red",
          statusCode: 200,
        },
      },
      {
        type: "csp-violation",
        url: "https://signloop.example/dashboard?draft=1",
        body: {
          blockedURL: "data:image/png;base64,AAAA",
          effectiveDirective: "img-src",
        },
      },
      {
        type: "csp-violation",
        url: "https://signloop.example/",
        body: {
          documentURL: "https://signloop.example/",
          blockedURL: "blob:https://signloop.example/5b7d7f63-8f61-4a52-9d6f-3a0c1b2e4d10",
          effectiveDirective: "worker-src",
        },
      },
      { type: "deprecation", url: "https://signloop.example/", body: { id: "x" } },
    ];

    const response = await POST(
      report(JSON.stringify(body), "application/reports+json; charset=utf-8"),
    );

    expect(response.status).toBe(204);
    expect(logged()).toEqual([
      "CSP violation: directive=style-src-attr blocked=inline page=/settings",
      "CSP violation: directive=img-src blocked=data: page=/dashboard",
      "CSP violation: directive=worker-src blocked=blob: page=/",
    ]);
  });

  it("falls back to the violated directive and marks values it cannot read", async () => {
    const body = {
      "csp-report": {
        "violated-directive": "img-src 'self'",
        "blocked-uri": "not a url\nwith a line break",
        "document-uri": "about:blank",
      },
    };

    const response = await POST(report(JSON.stringify(body), "application/csp-report"));

    expect(response.status).toBe(204);
    expect(logged()).toEqual(["CSP violation: directive=img-src blocked=unknown page=blank"]);
  });

  it("logs at most 20 violations of a batch and counts the rest", async () => {
    const entry = {
      type: "csp-violation",
      body: {
        documentURL: "https://signloop.example/",
        blockedURL: "eval",
        effectiveDirective: "script-src",
      },
    };

    const response = await POST(
      report(JSON.stringify(Array(25).fill(entry)), "application/reports+json"),
    );

    expect(response.status).toBe(204);
    expect(logged()).toHaveLength(21);
    expect(logged().at(-1)).toBe("CSP violation: 5 more in the same report");
  });

  it("rejects bodies over 16 KiB with 413, whatever the declared length", async () => {
    const padding = "a".repeat(MAX_BYTES);
    const oversize = JSON.stringify({ "csp-report": { "script-sample": padding } });

    const declared = await POST(report(oversize, "application/csp-report"));
    expect(declared.status).toBe(413);

    // A streamed body has no Content-Length, so the cap applies while reading.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(oversize.slice(0, MAX_BYTES / 2)));
        controller.enqueue(encoder.encode(oversize.slice(MAX_BYTES / 2)));
        controller.close();
      },
    });
    const streamed = await POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a report of exactly 16 KiB", async () => {
    const base = JSON.stringify({ "csp-report": { "script-sample": "" } });
    const body = JSON.stringify({
      "csp-report": { "script-sample": "a".repeat(MAX_BYTES - base.length) },
    });
    expect(body.length).toBe(MAX_BYTES);

    const response = await POST(report(body, "application/csp-report"));

    expect(response.status).toBe(204);
  });

  it("refuses other content types with 415 and malformed JSON with 400", async () => {
    const json = await POST(report(JSON.stringify(reportUriBody), "application/json"));
    expect(json.status).toBe(415);
    const none = await POST(
      new Request("http://localhost/api/csp-report", { method: "POST", body: "{}" }),
    );
    expect(none.status).toBe(415);

    const malformed = await POST(report("{not json", "application/csp-report"));
    expect(malformed.status).toBe(400);
    expect(warn).not.toHaveBeenCalled();
  });
});
