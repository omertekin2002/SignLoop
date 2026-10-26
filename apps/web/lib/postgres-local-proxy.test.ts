import { describe, expect, it } from "vitest";
import { configurePostgresLocalProxy } from "./postgres-local-proxy";

function neonDefaults() {
  return {
    wsProxy: (host: string) => `${host}/v2`,
    useSecureWebSocket: true,
    pipelineTLS: false,
    pipelineConnect: "password" as const,
    fetchEndpoint: (host: string) => `https://${host}/sql`,
  };
}

describe("configurePostgresLocalProxy", () => {
  it("leaves the Neon driver unchanged without POSTGRES_LOCAL_PROXY", () => {
    const config = neonDefaults();
    const before = { ...config };
    configurePostgresLocalProxy({ POSTGRES_URL: "postgresql://u:p@localhost:5432/db" }, config);
    expect(config).toEqual(before);
  });

  it("routes a localhost database's WebSocket and HTTP queries through the proxy", () => {
    const config = neonDefaults();
    configurePostgresLocalProxy(
      { POSTGRES_URL: "postgresql://u:p@localhost:5432/db", POSTGRES_LOCAL_PROXY: "127.0.0.1:3101" },
      config,
    );
    expect(config).toEqual({
      wsProxy: "127.0.0.1:3101/v1",
      useSecureWebSocket: false,
      pipelineTLS: false,
      pipelineConnect: false,
      fetchEndpoint: "http://127.0.0.1:3101/sql",
    });
  });

  it.each([
    "postgresql://u:p@ep-example-pooler.eu-central-1.aws.neon.tech/db",
    "postgresql://u:p@127.0.0.1:5432/db",
    "not a url",
    undefined,
  ])("refuses the proxy for POSTGRES_URL %s", (url) => {
    const config = neonDefaults();
    expect(() =>
      configurePostgresLocalProxy(
        { POSTGRES_URL: url, POSTGRES_LOCAL_PROXY: "127.0.0.1:3101" },
        config,
      ),
    ).toThrow("POSTGRES_LOCAL_PROXY is only allowed when POSTGRES_URL points at localhost");
    expect(config.useSecureWebSocket).toBe(true);
  });
});
