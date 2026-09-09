import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";
// Explicit package entry avoids Bun's built-in shim, which lacks custom dispatchers.
import { Agent } from "undici/index.js";
import { isPublicIpAddress } from "@/lib/public-ip";

// Validate the addresses returned to the socket itself. A separate DNS preflight
// followed by a normal fetch would resolve twice and permit DNS rebinding.
export const lookupPublicAddress: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
      callback(new Error("The host did not resolve exclusively to public IP addresses."), []);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

export function createPublicHttpDispatcher(): Agent {
  return new Agent({ connect: { lookup: lookupPublicAddress }, autoSelectFamily: true });
}
