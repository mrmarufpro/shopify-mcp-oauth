import dns from "node:dns/promises";
import net from "node:net";
import type { ResolvedConfig } from "../config";
import { OAuthError } from "../errors";
import { cimdDocumentSchema, type CimdDocument } from "../schemas/cimd";
import type { Logger } from "../types";
import { clientToCimdDocument, upsertCimdClient } from "./clients";

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 3000;
const CACHE_TTL_SECONDS = 3600;
const CACHE_PREFIX = "mcp:oauth:cimd:";
// Deliberately much shorter than CACHE_TTL_SECONDS above: a merchant's CIMD endpoint that's down
// for a minute and back shouldn't leave their client_id rejected for an hour. Negative-caching a
// recently-failed URL at all is the natural companion to the concurrency cap below — a client
// hammering the same known-bad URL is the same resource-exhaustion shape as one spreading load
// across many distinct URLs, just concentrated on one instead.
const NEGATIVE_CACHE_TTL_SECONDS = 60;
const NEGATIVE_CACHE_PREFIX = "mcp:oauth:cimd:failed:";

export function isCimdClientId(value: string): boolean {
  return value.startsWith("https://");
}

interface PrivateAddressRange {
  type: net.IPVersion;
  subnet: string;
  prefix: number;
}

// Every family the SSRF guard must reject, expressed as CIDR ranges rather than string-prefix
// matching on address text. net.BlockList classifies by the address's actual numeric value, so a
// v4-mapped IPv6 literal (e.g. "::ffff:7f00:1" -- the hex-hextet form WHATWG URL produces for
// "[::ffff:127.0.0.1]") is caught by its 128-bit value, not by which textual notation it happens
// to be written in.
//
// No separate "IPv4-mapped" entry is listed here (verified, not assumed): net.BlockList already
// normalizes an "ipv4"-typed rule to also match its IPv4-mapped IPv6 form automatically (a bare
// "127.0.0.0/8, ipv4" rule alone blocks check("::ffff:127.0.0.1", "ipv6")), so every ipv4 range
// below already covers its own mapped form for free. Adding an explicit "::ffff:0:0/96, ipv6"
// rule on top of that was tried and measured to be actively harmful, not merely redundant: because
// net.BlockList normalizes a plain IPv4 check the same way in reverse, that single subnet made
// check(anyIPv4, "ipv4") return true unconditionally -- it silently rejected every public IPv4
// host, including 8.8.8.8. Caught by the "does not reject a public IPv4/IPv6 host" tests below,
// which is exactly what they exist to guard against.
//
// The deprecated IPv4-compatible notation ("::a.b.c.d", distinct from IPv4-mapped) is deliberately
// not covered. A single blanket "::/96" rule can't discriminate an embedded public address from an
// embedded private one (verified: check("::808:808" [8.8.8.8's compatible form], "ipv6") is also
// true) -- the private ranges could instead be enumerated individually as explicit ipv6 rules in
// this notation, the same way the ipv4 ranges are, but that notation has been obsolete since RFC
// 4291 (2006), is never produced by dns.lookup or by WHATWG URL's own IPv6 serialization, and
// offers an attacker nothing that IPv4-mapped notation doesn't already give them -- not worth the
// extra entries for a notation nothing in this guard's real inputs ever produces.
const PRIVATE_ADDRESS_RANGES: PrivateAddressRange[] = [
  { type: "ipv4", subnet: "0.0.0.0", prefix: 8 }, // "this network"
  { type: "ipv4", subnet: "10.0.0.0", prefix: 8 }, // RFC 1918 private
  { type: "ipv4", subnet: "100.64.0.0", prefix: 10 }, // RFC 6598 carrier-grade NAT
  { type: "ipv4", subnet: "127.0.0.0", prefix: 8 }, // loopback
  { type: "ipv4", subnet: "169.254.0.0", prefix: 16 }, // link-local, incl. cloud metadata hosts
  { type: "ipv4", subnet: "172.16.0.0", prefix: 12 }, // RFC 1918 private
  { type: "ipv4", subnet: "192.0.0.0", prefix: 24 }, // IETF protocol assignments
  { type: "ipv4", subnet: "192.168.0.0", prefix: 16 }, // RFC 1918 private
  { type: "ipv4", subnet: "198.18.0.0", prefix: 15 }, // benchmarking (RFC 2544)
  { type: "ipv4", subnet: "224.0.0.0", prefix: 4 }, // multicast
  { type: "ipv4", subnet: "240.0.0.0", prefix: 4 }, // reserved, incl. 255.255.255.255 broadcast
  { type: "ipv6", subnet: "::1", prefix: 128 }, // loopback
  { type: "ipv6", subnet: "::", prefix: 128 }, // unspecified
  { type: "ipv6", subnet: "fe80::", prefix: 10 }, // link-local
  { type: "ipv6", subnet: "fec0::", prefix: 10 }, // deprecated site-local
  { type: "ipv6", subnet: "fc00::", prefix: 7 }, // unique local (covers both fc00::/8 and fd00::/8)
  { type: "ipv6", subnet: "ff00::", prefix: 8 }, // multicast, for symmetry with 224.0.0.0/4 above
];

function buildPrivateAddressBlockList(): net.BlockList {
  const blockList = new net.BlockList();
  for (const range of PRIVATE_ADDRESS_RANGES) {
    blockList.addSubnet(range.subnet, range.prefix, range.type);
  }
  return blockList;
}

const privateAddressBlockList = buildPrivateAddressBlockList();

// Expands any valid IPv6 literal (net.isIPv6 must already be true) to its 8 constituent 16-bit
// groups, handling "::" compression and an embedded IPv4 dotted-quad tail (e.g. "::ffff:1.2.3.4").
// Used only to pull specific groups out at fixed offsets for NAT64/6to4 detection below -- this is
// not a general-purpose formatter.
function expandIpv6Groups(addr: string): number[] | null {
  const lastColonIndex = addr.lastIndexOf(":");
  const tail = addr.slice(lastColonIndex + 1);
  const normalized = net.isIPv4(tail) ? `${addr.slice(0, lastColonIndex + 1)}${ipv4ToHexGroups(tail).join(":")}` : addr;

  let groups: string[];
  if (normalized.includes("::")) {
    const [head = "", tailPart = ""] = normalized.split("::");
    const headGroups = head ? head.split(":").filter((group) => group.length > 0) : [];
    const tailGroups = tailPart ? tailPart.split(":").filter((group) => group.length > 0) : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  } else {
    groups = normalized.split(":");
  }
  if (groups.length !== 8) return null;

  const result: number[] = [];
  for (const group of groups) {
    const value = parseInt(group === "" ? "0" : group, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
    result.push(value);
  }
  return result;
}

function ipv4ToHexGroups(ipv4: string): [string, string] {
  const octets = ipv4.split(".").map(Number);
  const hi = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)) >>> 0;
  const lo = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0;
  return [hi.toString(16), lo.toString(16)];
}

function groupsToIpv4(high: number, low: number): string {
  return [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff].join(".");
}

// NAT64 (RFC 6052, "64:ff9b::/96") and 6to4 (RFC 3056, "2002::/16") both carry a plain IPv4 address
// at a fixed bit offset rather than being private ranges in their own right. A blanket BlockList
// rule over either whole prefix can't tell an embedded private address from an embedded public one
// (verified: it blocks 8.8.8.8's NAT64/6to4 forms exactly as readily as 169.254.169.254's -- the
// same "::/96 can't discriminate" problem already documented above for IPv4-compatible notation,
// just relocated to these prefixes). So instead of adding table rows for these notations, extract
// the embedded IPv4 and reclassify *that* through the one set of ipv4 rules already above --
// there's nothing to keep in sync if a twelfth ipv4 range is ever added, because there's no second
// list of ranges written in these notations to forget to update.
//
// Teredo ("2001::/32") is deliberately not handled the same way: its embedded bits are the
// tunneling client's own obfuscated public address/port for a specific peer-to-peer session, not
// an arbitrary routable target the way NAT64/6to4 embed one -- there's no "the real destination" to
// extract. It's also disabled by default on effectively every current platform, so it doesn't carry
// NAT64's "real, deployed gateway" justification for accepting any residual risk here.
function extractEmbeddedIpv4(addr: string): string | null {
  const groups = expandIpv6Groups(addr);
  if (!groups) return null;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return groupsToIpv4(g6 ?? 0, g7 ?? 0);
  }
  if (g0 === 0x2002) {
    return groupsToIpv4(g1 ?? 0, g2 ?? 0);
  }
  return null;
}

function isPrivateOrLoopbackIp(addr: string): boolean {
  if (net.isIPv4(addr)) return privateAddressBlockList.check(addr, "ipv4");
  if (net.isIPv6(addr)) {
    const embeddedIpv4 = extractEmbeddedIpv4(addr);
    if (embeddedIpv4) return privateAddressBlockList.check(embeddedIpv4, "ipv4");
    return privateAddressBlockList.check(addr, "ipv6");
  }
  // Not a recognizable IP literal at all. Unreachable via this file's current call sites (both
  // only ever pass a value net.isIP has already validated) -- kept as defense in depth rather than
  // silently treating an unrecognized value as public.
  return true;
}

// URL.hostname keeps the brackets on an IPv6 literal (e.g. "[::1]"), but net.isIP/isIPv6 only
// recognize the bare address — strip them before classifying, or every IPv6 literal silently
// falls through to dns.lookup(), which fails the whole request with a generic ENOTFOUND instead
// of the intended private-address rejection.
function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return hostname;
}

async function assertPublicHost(url: URL, logger: Logger): Promise<void> {
  const host = url.hostname;
  const literal = stripIpv6Brackets(host);
  if (net.isIP(literal)) {
    if (isPrivateOrLoopbackIp(literal)) {
      // The caller supplied this IP literally, so naming it back is not a disclosure of anything
      // they don't already know.
      throw new OAuthError("invalid_client", `CIMD URL host ${literal} resolves to a private/loopback address`);
    }
    return;
  }
  try {
    const addresses = await dns.lookup(host, { all: true });
    for (const address of addresses) {
      if (isPrivateOrLoopbackIp(address.address)) {
        // Unlike the literal-IP branch above, this address came from *our* resolver, not from the
        // caller — split-horizon DNS means it can differ from what the caller's own resolver would
        // return, so it's internal information and must not ride in the client-facing description.
        // The full detail (including the resolved address) still goes to the log, for our own
        // debugging.
        logger.warn(
          `cimd: rejected CIMD URL host ${host}, which resolved to private/loopback address ${address.address}`
        );
        throw new OAuthError("invalid_client", `CIMD URL host ${host} resolves to a private/loopback address`);
      }
    }
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("invalid_client", `CIMD URL host ${host} could not be resolved`);
  }
}

// Reads the response body through its stream, counting real bytes as they arrive and aborting
// as soon as the running total exceeds MAX_BYTES — this never consults Content-Length, so a
// chunked-transfer-encoding response that omits it entirely is capped exactly the same way. A
// response with no stream to read is refused outright rather than falling back to an unbounded
// response.text() read, which would defeat the cap for any fetchImpl that doesn't expose one.
async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new OAuthError("invalid_client", "CIMD fetch response has no readable body");
  }
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new OAuthError("invalid_client", `CIMD document exceeds ${MAX_BYTES} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    // The timeout's AbortController is wired to this same read (see fetchCimd) -- a body that
    // stalls past TIMEOUT_MS rejects here, not at the initial fetchImpl call. Fixed text, not the
    // caught error's message, either way: a raw stream error could carry connection-level detail.
    if (error instanceof Error && error.name === "AbortError") {
      throw new OAuthError("invalid_client", "CIMD document fetch was aborted (timed out)");
    }
    throw new OAuthError("invalid_client", "CIMD document could not be read");
  }
  return text + decoder.decode();
}

async function fetchCimd(config: ResolvedConfig, urlStr: string, allowPrivateHosts: boolean): Promise<CimdDocument> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new OAuthError("invalid_client", "CIMD client_id must be a valid URL");
  }
  if (url.protocol !== "https:") throw new OAuthError("invalid_client", "CIMD client_id must use HTTPS");
  if (!allowPrivateHosts) await assertPublicHost(url, config.logger);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let text: string;
  try {
    // The timer must stay live through the body read, not just the initial fetch -- a server
    // that responds with headers immediately but drips the body slowly (staying under the byte
    // cap the whole time) would otherwise pin a handler and a socket indefinitely.
    let response: Response;
    try {
      response = await config.fetchImpl(urlStr, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      // Fixed text, not the caught error's message: a raw network error (e.g. a connection-refused
      // message naming an address) is server-side detail about how *we* tried to reach the
      // client's host, not a judgment about the client's document — but classifying it as
      // OAuthError here is still correct, because from an unauthenticated caller's point of view
      // "we couldn't fetch your document" is exactly as safe to say as any of the throws below.
      if (error instanceof Error && error.name === "AbortError") {
        throw new OAuthError("invalid_client", "CIMD document fetch was aborted (timed out)");
      }
      throw new OAuthError("invalid_client", "CIMD document could not be fetched");
    }
    if (!response.ok) throw new OAuthError("invalid_client", `CIMD fetch returned ${response.status}`);
    // The byte cap is enforced here, before JSON.parse ever runs — an oversized body never
    // reaches the parser, let alone the schema, regardless of whether it would have been valid
    // JSON.
    text = await readBodyCapped(response);
  } finally {
    clearTimeout(timer);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OAuthError("invalid_client", "CIMD document is not valid JSON");
  }
  const parsed = cimdDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) throw new OAuthError("invalid_client", "CIMD document is invalid");
    // zod's own message for a missing required field is the generic "Required", with no mention
    // of which field — prefix the field path so callers (and this file's own tests) can tell
    // which part of the document failed without inspecting the ZodError directly.
    const message = issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
    throw new OAuthError("invalid_client", message);
  }
  return parsed.data;
}

export async function resolveCimdClient(
  config: ResolvedConfig,
  url: string,
  opts: { allowPrivateHosts?: boolean } = {}
): Promise<CimdDocument> {
  if (!isCimdClientId(url)) throw new OAuthError("invalid_client", "CIMD client_id must use HTTPS");

  const cacheKey = `${CACHE_PREFIX}${url}`;
  try {
    const cached = await config.cache.get(cacheKey);
    if (cached) return JSON.parse(cached) as CimdDocument;
  } catch {
    // A cache outage must not break login; fall through to storage and the network.
  }

  // Left unguarded deliberately: a storage failure here is an infrastructure error, not a
  // statement about the client's own CIMD document, and must propagate as an ordinary Error so
  // it reaches the caller's generic-failure path instead of being classified as OAuthError
  // ("this client_id is invalid") — see the throws above and below, which are all judgments about
  // the client's own URL/document and are safe to name to an unauthenticated caller.
  const stored = await config.storage.findClient(url);
  if (stored) {
    const doc = clientToCimdDocument(stored);
    await config.cache.set(cacheKey, JSON.stringify(doc), CACHE_TTL_SECONDS).catch(() => {});
    return doc;
  }

  // Checked only once neither cache above nor storage already has a real document -- a URL that
  // failed recently and has since been fixed (and so now HAS a real document) must never be
  // shadowed by a stale failure marker; storage/the success cache winning first, unconditionally,
  // is what guarantees that.
  const negativeCacheKey = `${NEGATIVE_CACHE_PREFIX}${url}`;
  try {
    const cachedFailureDescription = await config.cache.get(negativeCacheKey);
    if (cachedFailureDescription) throw new OAuthError("invalid_client", cachedFailureDescription);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    // A cache outage here must not break resolution; fall through to a real fetch attempt.
  }

  // The concurrency cap bounds the whole fetchCimd call, not just the initial fetchImpl request --
  // the resource being protected (an open outbound socket) stays held through the body read and
  // its own TIMEOUT_MS-bounded wait too, so a cap that released after the headers arrived would
  // leave the slower, still-expensive tail of the same request uncapped.
  let doc: CimdDocument;
  try {
    doc = await config.cimdFetchLimiter.run(() => fetchCimd(config, url, opts.allowPrivateHosts ?? false));
  } catch (error) {
    if (error instanceof OAuthError) {
      await config.cache.set(negativeCacheKey, error.description, NEGATIVE_CACHE_TTL_SECONDS).catch(() => {});
    }
    throw error;
  }

  try {
    await upsertCimdClient(config, url, doc);
  } catch (error) {
    config.logger.error("cimd: failed to persist client", error);
  }
  await config.cache.set(cacheKey, JSON.stringify(doc), CACHE_TTL_SECONDS).catch(() => {});
  return doc;
}
