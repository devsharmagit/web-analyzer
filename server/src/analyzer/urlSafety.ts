// Rejects analysis targets that point at private, loopback, link-local or
// otherwise non-public addresses. The analyzer fetches whatever URL it's
// given, so without this /api/analyze?url=http://169.254.169.254/ would make
// the server probe its own cloud metadata endpoint or internal network (SSRF).
//
// This checks the hostname once, when the analysis starts (and for external
// store links before they're fetched). It does not re-check every redirect
// hop or guard against DNS rebinding — closing that fully means validating at
// the socket level on every request.
//
// Set ALLOW_PRIVATE_TARGETS=1 to analyze a site on localhost/LAN during dev.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata endpoints
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

export function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return !BLOCKED_V4.some(([base, bits]) => inV4Range(ip, base, bits));
  if (version !== 6) return false;

  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:127.0.0.1 or ::ffff:7f00:1) — judge the embedded IPv4.
  const mapped = lower.match(/^::ffff:(.+)$/);
  if (mapped) {
    const rest = mapped[1]!;
    if (isIP(rest) === 4) return isPublicIp(rest);
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!hex) return false;
    const n = (parseInt(hex[1]!, 16) << 16) + parseInt(hex[2]!, 16);
    return isPublicIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d form
  if (lower.startsWith("::")) return false;
  const first = parseInt(lower.split(":")[0]!, 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")) return false; // documentation
  return true;
}

/**
 * Parse a user-supplied site URL (scheme optional) and confirm it points at a
 * public host. Throws UnsafeUrlError otherwise. A hostname that doesn't
 * resolve at all is allowed through, so the crawl can report it as a dead
 * domain the same way it always has.
 */
export async function assertPublicUrl(input: string): Promise<URL> {
  const scheme = input.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") {
    throw new UnsafeUrlError(`Only http and https URLs can be analyzed: ${input}`);
  }
  let url: URL;
  try {
    url = new URL(scheme ? input : "https://" + input);
  } catch {
    throw new UnsafeUrlError(`Not a usable URL: ${input}`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs containing credentials can't be analyzed");
  }
  if (process.env.ALLOW_PRIVATE_TARGETS === "1") return url;
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new UnsafeUrlError(`Only the standard web ports (80, 443) can be analyzed, not :${url.port}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) {
    throw new UnsafeUrlError(`${host} is not a public website`);
  }
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError(`${host} is a private or reserved address`);
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return url; // doesn't resolve — let the crawl report the dead domain
  }
  if (addresses.some((a) => !isPublicIp(a.address))) {
    throw new UnsafeUrlError(`${host} resolves to a private or reserved address`);
  }
  return url;
}

export async function isPublicUrl(input: string): Promise<boolean> {
  try {
    await assertPublicUrl(input);
    return true;
  } catch {
    return false;
  }
}
