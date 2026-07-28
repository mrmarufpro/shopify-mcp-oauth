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

function isPrivateOrLoopbackIp(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (net.isIPv4(mapped)) return isPrivateOrLoopbackIp(mapped);
    }
    return false;
  }
  return false;
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
  let response: Response;
  try {
    response = await config.fetchImpl(urlStr, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`CIMD fetch returned ${response.status}`);

  // The byte cap is enforced here, before JSON.parse ever runs — an oversized body never reaches
  // the parser, let alone the schema, regardless of whether it would have been valid JSON.
  const text = await readBodyCapped(response);
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
