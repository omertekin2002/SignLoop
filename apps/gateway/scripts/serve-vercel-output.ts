// Serves the built Vercel Function (.vercel/output, from `bun run build:vercel`) with Node.js on
// 127.0.0.1, to check the deployment build locally; CI boots it and probes /healthz. From
// apps/gateway: `bun run serve:vercel [port]` (default 10000). The function reads its
// configuration from the environment when the module loads, as on Vercel.
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

type FetchHandler = { fetch: (request: Request) => Promise<Response> };

const entry = join(
  dirname(fileURLToPath(import.meta.url)),
  "../.vercel/output/functions/index.func/index.mjs",
);
const handler = (
  (await import(pathToFileURL(entry).href)) as { default: FetchHandler }
).default;

const hostname = "127.0.0.1";
const port = Number(process.argv[2] ?? 10_000);

createServer(async (incoming, outgoing) => {
  // As with Vercel's supportsCancellation, a client disconnect aborts request.signal.
  const disconnect = new AbortController();
  outgoing.on("close", () => {
    if (!outgoing.writableFinished) disconnect.abort();
  });

  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2)
    headers.append(
      incoming.rawHeaders[index]!,
      incoming.rawHeaders[index + 1]!,
    );
  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";

  try {
    const response = await handler.fetch(
      new Request(new URL(incoming.url ?? "/", `http://${hostname}:${port}`), {
        method: incoming.method,
        headers,
        // Node's and the DOM library's stream types differ only nominally.
        body: hasBody
          ? (Readable.toWeb(incoming) as unknown as BodyInit)
          : undefined,
        duplex: "half",
        signal: disconnect.signal,
      } as RequestInit),
    );
    outgoing.writeHead(response.status, [...response.headers].flat());
    // Write each chunk as it arrives so NDJSON streams through.
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      outgoing.write(value);
    }
    outgoing.end();
  } catch (error) {
    console.error(error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}).listen(port, hostname, () => {
  console.log(`Vercel function build listening on http://${hostname}:${port}/`);
});
