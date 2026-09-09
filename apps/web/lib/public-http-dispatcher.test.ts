import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { afterEach, expect, it, vi } from "vitest";
const { dnsLookup } = vi.hoisted(() => ({ dnsLookup: vi.fn() }));
vi.mock("node:dns", () => ({ lookup: dnsLookup }));
import { lookupPublicAddress } from "./public-http-dispatcher";
import { isPublicIpAddress } from "./public-ip";
import { httpGet } from "./http-fetch";

afterEach(() => { dnsLookup.mockReset(); });

function resolveTo(addresses: LookupAddress[]) {
  dnsLookup.mockImplementation((_host, _options, callback) => callback(null, addresses));
}

it.each([
  "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
  "192.168.1.1", "100.64.0.1", "198.18.0.1", "192.0.2.1", "224.0.0.1", "240.0.0.1",
  "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
  "64:ff9b::a00:1", "2002:7f00:1::", "invalid",
])("rejects non-public address %s", (address) => {
  expect(isPublicIpAddress(address)).toBe(false);
});

it("hands only the validated DNS result directly to the socket, preserving both families", () => {
  const addresses = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  resolveTo(addresses);
  const callback = vi.fn();
  lookupPublicAddress("public.test", { all: true }, callback);
  expect(dnsLookup).toHaveBeenCalledOnce();
  expect(callback).toHaveBeenCalledWith(null, addresses);
  dnsLookup.mockClear();
  lookupPublicAddress("public.test", {}, callback);
  expect(dnsLookup).toHaveBeenCalledOnce();
  expect(callback).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
});

it("rejects mixed public/private answers and revalidates later connections", () => {
  const callback = vi.fn();
  resolveTo([{ address: "8.8.8.8", family: 4 }]);
  lookupPublicAddress("changing.test", { all: true }, callback);
  expect(callback).toHaveBeenLastCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  resolveTo([{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }]);
  lookupPublicAddress("changing.test", { all: true }, callback);
  expect(callback).toHaveBeenLastCalledWith(expect.any(Error), []);
});

it("propagates DNS failures and rejects empty answers", () => {
  const callback = vi.fn();
  const error = new Error("DNS unavailable");
  dnsLookup.mockImplementation((_host, _options, done) => done(error));
  lookupPublicAddress("missing.test", {}, callback);
  expect(callback).toHaveBeenLastCalledWith(error, []);
  resolveTo([]);
  lookupPublicAddress("empty.test", {}, callback);
  expect(callback).toHaveBeenLastCalledWith(expect.any(Error), []);
});

it("prevents real HTTP requests to a loopback-only server, including DNS aliases", async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end("private"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    resolveTo([{ address: "127.0.0.1", family: 4 }]);
    for (const host of ["localhost.", "alias.test"]) {
      await expect(httpGet(`http://${host}:${port}/probe`, { signal: AbortSignal.timeout(3000) }))
        .rejects.toHaveProperty("publicMessage");
    }
    expect(dnsLookup).toHaveBeenCalledWith("alias.test", expect.anything(), expect.any(Function));
    expect(requests).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
