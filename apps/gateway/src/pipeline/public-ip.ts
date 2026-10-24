// Ported from SignLoop apps/web/lib/public-ip.ts at 3f830abaae4d47dedecabea3fca57a4899a8f688.
import ipaddr from "ipaddr.js";

/** Fail closed for private, local, mapped, reserved, and transition address ranges. */
export function isPublicIpAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    return (
      parsed.range() === "unicast" &&
      (parsed.kind() === "ipv4" || parsed.match(ipaddr.parse("2000::"), 3))
    );
  } catch {
    return false;
  }
}
