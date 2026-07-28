import dns from "node:dns/promises";
import net from "node:net";
import type { ResolvedConfig } from "../config";
import { cimdDocumentSchema, type CimdDocument } from "../schemas/cimd";
import { clientToCimdDocument, upsertCimdClient } from "./clients";

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 3000;
const CACHE_TTL_SECONDS = 3600;
const CACHE_PREFIX = "mcp:oauth:cimd:";

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
// not covered: net.BlockList has no way to extract just the embedded address from an "::/96" rule,
// so a blanket entry there blocks every address in that notation indiscriminately -- including
// public ones (verified: check("::808:808" [8.8.8.8's compatible form], "ipv6") is also true).
// That notation has been obsolete since RFC 4291 (2006), is never produced by dns.lookup or by
// WHATWG URL's own IPv6 serialization, and offers an attacker nothing that IPv4-mapped notation
// doesn't already give them -- not worth the false-positive cost of a blanket rule.
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
];

function buildPrivateAddressBlockList(): net.BlockList {
  const blockList = new net.BlockList();
  for (const range of PRIVATE_ADDRESS_RANGES) {
    blockList.addSubnet(range.subnet, range.prefix, range.type);
  }
  return blockList;
}

const privateAddressBlockList = buildPrivateAddressBlockList();

function isPrivateOrLoopbackIp(addr: string): boolean {
  if (net.isIPv4(addr)) return privateAddressBlockList.check(addr, "ipv4");
  if (net.isIPv6(addr)) return privateAddressBlockList.check(addr, "ipv6");
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

async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname;
  const literal = stripIpv6Brackets(host);
  if (net.isIP(literal)) {
    if (isPrivateOrLoopbackIp(literal)) {
      throw new Error(`CIMD URL host ${literal} resolves to a private/loopback address`);
    }
    return;
  }
  const addresses = await dns.lookup(host, { all: true });
  for (const address of addresses) {
    if (isPrivateOrLoopbackIp(address.address)) {
      throw new Error(`CIMD URL host ${host} resolves to a private/loopback address (${address.address})`);
    }
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
    throw new Error("CIMD fetch response has no readable body");
  }
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`CIMD document exceeds ${MAX_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchCimd(config: ResolvedConfig, urlStr: string, allowPrivateHosts: boolean): Promise<CimdDocument> {
  const url = new URL(urlStr);
  if (url.protocol !== "https:") throw new Error("CIMD client_id must use HTTPS");
  if (!allowPrivateHosts) await assertPublicHost(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let text: string;
  try {
    // The timer must stay live through the body read, not just the initial fetch -- a server
    // that responds with headers immediately but drips the body slowly (staying under the byte
    // cap the whole time) would otherwise pin a handler and a socket indefinitely.
    const response = await config.fetchImpl(urlStr, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`CIMD fetch returned ${response.status}`);
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
    throw new Error("CIMD document is not valid JSON");
  }
  const parsed = cimdDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) throw new Error("CIMD document is invalid");
    // zod's own message for a missing required field is the generic "Required", with no mention
    // of which field — prefix the field path so callers (and this file's own tests) can tell
    // which part of the document failed without inspecting the ZodError directly.
    const message = issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
    throw new Error(message);
  }
  return parsed.data;
}

export async function resolveCimdClient(
  config: ResolvedConfig,
  url: string,
  opts: { allowPrivateHosts?: boolean } = {}
): Promise<CimdDocument> {
  if (!isCimdClientId(url)) throw new Error("CIMD client_id must use HTTPS");

  const cacheKey = `${CACHE_PREFIX}${url}`;
  try {
    const cached = await config.cache.get(cacheKey);
    if (cached) return JSON.parse(cached) as CimdDocument;
  } catch {
    // A cache outage must not break login; fall through to storage and the network.
  }

  const stored = await config.storage.findClient(url);
  if (stored) {
    const doc = clientToCimdDocument(stored);
    await config.cache.set(cacheKey, JSON.stringify(doc), CACHE_TTL_SECONDS).catch(() => {});
    return doc;
  }

  const doc = await fetchCimd(config, url, opts.allowPrivateHosts ?? false);

  try {
    await upsertCimdClient(config, url, doc);
  } catch (error) {
    config.logger.error("cimd: failed to persist client", error);
  }
  await config.cache.set(cacheKey, JSON.stringify(doc), CACHE_TTL_SECONDS).catch(() => {});
  return doc;
}
