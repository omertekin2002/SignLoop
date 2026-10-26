import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { DatabaseError, Pool } from "pg";
import { WebSocketServer } from "ws";

export type NeonLocalProxy = { close(): Promise<void> };

// Error fields the Neon driver copies from an HTTP 400 onto its NeonDbError.
const ERROR_FIELDS = [
  "severity", "code", "detail", "hint", "position", "internalPosition", "internalQuery",
  "where", "schema", "table", "column", "dataType", "constraint", "file", "line", "routine",
] as const;

// Return every value as PostgreSQL's text output; the driver applies its own type parsers.
const RAW_TEXT = { getTypeParser: () => (value: string) => value };

// A minimal local stand-in for Neon's proxy, for the app's POSTGRES_LOCAL_PROXY
// (lib/postgres-local-proxy.ts). Each WebSocket carries one PostgreSQL connection as raw
// wire-protocol bytes, and POST /sql runs one parameterised query the way Neon's HTTP endpoint
// does. Everything goes to the one database at `databaseUrl`; the address and connection string
// the driver sends are ignored, so the proxy cannot reach any other server.
export async function startNeonLocalProxy(
  port: number,
  databaseUrl: string,
): Promise<NeonLocalProxy> {
  const target = new URL(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });

  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/sql") {
      void runHttpQuery(pool, request, response);
    } else {
      response.writeHead(404).end();
    }
  });

  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    const database = connect(Number(target.port || 5432), target.hostname);
    // Writes before the TCP connection opens are buffered by the socket. The default
    // "nodebuffer" binary type delivers each message as one Buffer.
    socket.on("message", (data) => database.write(data as Buffer));
    socket.on("close", () => database.end());
    socket.on("error", () => database.destroy());
    database.on("data", (chunk) => socket.send(chunk));
    database.on("close", () => socket.close());
    database.on("error", () => socket.terminate());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

async function runHttpQuery(pool: Pool, request: IncomingMessage, response: ServerResponse) {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    // The app sends single queries only; batches (transaction()) are not supported.
    const { query, params } = JSON.parse(body) as { query: string; params: unknown[] };
    const result = await pool.query({ text: query, values: params, rowMode: "array", types: RAW_TEXT });
    sendJson(response, 200, {
      command: result.command,
      rowCount: result.rowCount,
      rows: result.rows,
      fields: result.fields,
      rowAsArray: true,
    });
  } catch (error) {
    if (error instanceof DatabaseError) {
      const fields = Object.fromEntries(ERROR_FIELDS.map((name) => [name, error[name]]));
      sendJson(response, 400, { message: error.message, ...fields });
    } else {
      response.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
    }
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
