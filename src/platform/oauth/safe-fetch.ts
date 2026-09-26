import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * The one outbound request the OAuth server makes on a client's say-so:
 * fetching a Client ID Metadata Document from a URL the client chose. Kept to
 * a single small function so its SSRF protections live in one place.
 */

/**
 * Whether an IP address is one the Hub must never be made to request: loopback,
 * private, link-local (including cloud metadata at 169.254.169.254), carrier
 * NAT, multicast, unspecified, and their IPv6 counterparts. Opening metadata
 * documents to any host turns the authorize endpoint into something anyone can
 * point at a URL of their choosing; this is what keeps that from reaching
 * anything but the public internet.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff")
  );
}

/** Cap on how long authorize waits on the client's host; Claude allows 10s end to end. */
const FETCH_TIMEOUT_MS = 4_000;
/** A metadata document is a few hundred bytes. Anything large is not one. */
const MAX_DOCUMENT_BYTES = 16_384;

/**
 * A DNS lookup for the metadata fetch's own socket that refuses private
 * addresses.
 *
 * The check has to live HERE, inside the connection's resolution, rather than
 * in a lookup run before the fetch: resolving once to check and letting the
 * HTTP client resolve again to connect is a DNS-rebinding hole -- an attacker's
 * name server answers the check with a public address and the connect with
 * 169.254.169.254. With the check in the socket's own lookup, the address that
 * passed is the address that is dialed.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 4);
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      const refused = Object.assign(new Error(`Refusing to connect to a private address for ${hostname}`), { code: "EPRIVATE" });
      return callback(refused, "", 4);
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * GET a small JSON document over https through publicOnlyLookup. node:https
 * rather than fetch because fetch exposes no per-request lookup hook. Never
 * follows redirects (https.request does not), and caps time and size.
 */
export function getPublicJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "GET", headers: { accept: "application/json" }, lookup: publicOnlyLookup, timeout: FETCH_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Metadata fetch returned ${res.statusCode}`));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > MAX_DOCUMENT_BYTES) req.destroy(new Error("Metadata document too large"));
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Metadata fetch timed out")));
    req.on("error", reject);
    req.end();
  });
}

