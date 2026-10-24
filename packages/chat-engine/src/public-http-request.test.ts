import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { Agent } from "undici/index.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  requestPublicHttp,
  UnsupportedContentEncodingError,
} from "./public-http-request";

// Large enough that the decoders and the socket both apply backpressure.
const TEXT = "SignLoop http_get body. ".repeat(20_000);
const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {
  "/gzip": (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    response.end(gzipSync(TEXT));
  },
  "/deflate": (_request, response) => {
    response.writeHead(200, { "content-encoding": "deflate" });
    response.end(deflateSync(TEXT));
  },
  "/br": (_request, response) => {
    response.writeHead(200, { "content-encoding": "br" });
    response.end(brotliCompressSync(TEXT));
  },
  "/gzip-then-br": (_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip, br" });
    response.end(brotliCompressSync(gzipSync(TEXT)));
  },
  "/chunked-gzip": (_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip" });
    const body = gzipSync(TEXT);
    for (let offset = 0; offset < body.length; offset += 997)
      response.write(body.subarray(offset, offset + 997));
    response.end();
  },
  "/plain": (request, response) => {
    response.writeHead(200, { "x-accept-encoding": request.headers["accept-encoding"] ?? "" });
    response.end(TEXT);
  },
  "/empty": (_request, response) => {
    response.writeHead(204);
    response.end();
  },
  "/zstd": (_request, response) => {
    response.writeHead(200, { "content-encoding": "zstd" });
    response.end("not really zstd");
  },
  "/stall": (_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip" });
    response.write(gzipSync(TEXT).subarray(0, 100));
  },
};
const server = createServer((request, response) => routes[request.url ?? ""]?.(request, response));
const dispatcher = new Agent();
let origin = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dispatcher.destroy();
});

const get = (path: string, signal?: AbortSignal) =>
  requestPublicHttp(new URL(path, origin), { dispatcher, headers: { "user-agent": "test" }, signal });

it.each(["/gzip", "/deflate", "/br", "/gzip-then-br", "/chunked-gzip", "/plain"])(
  "decodes %s into the original text",
  async (path) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(TEXT);
  },
);

it("asks for the encodings it can decode", async () => {
  const response = await get("/plain");
  expect(response.headers.get("x-accept-encoding")).toBe("gzip, deflate, br");
  await response.body?.cancel();
});

it("returns a null body for a 204", async () => {
  const response = await get("/empty");
  expect(response.status).toBe(204);
  expect(response.body).toBeNull();
});

it("rejects an encoding it cannot decode", async () => {
  await expect(get("/zstd")).rejects.toBeInstanceOf(UnsupportedContentEncodingError);
});

it("stops early on cancel without an unhandled error", async () => {
  const response = await get("/gzip");
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
});

it("aborts a body that stops arriving", async () => {
  const controller = new AbortController();
  const response = await get("/stall", controller.signal);
  const reading = response.text();
  setTimeout(() => controller.abort(new Error("deadline")), 50);
  await expect(reading).rejects.toThrow();
});
