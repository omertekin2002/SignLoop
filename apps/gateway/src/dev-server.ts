// Local development server (`bun run dev`). Production is the Vercel Function in vercel.ts; this
// serves the same handler with Bun so source edits reload without a build. Loopback only.
import { loadLocalPort } from "./config";
import { createVercelHandler } from "./vercel-handler";

const port = loadLocalPort();
const handler = createVercelHandler();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request, server) {
    // Preserve Bun's transport guard while parsing headers, then allow grounded research to be
    // quiet between response bytes. The handler's abort-aware timeout governs from this point.
    server.timeout(request, 0);
    return handler.fetch(request);
  },
});

console.log(`Gateway dev server listening on ${server.url.href}`);
