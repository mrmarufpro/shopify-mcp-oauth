import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import type { CacheStore } from "../types";
import { isCimdClientId, resolveCimdClient } from "./cimd";

const CIMD_URL = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const CIMD_DOC = { client_name: "Fetched Client", redirect_uris: [REDIRECT_URI] };

// The package's byte cap and fetch timeout on a fetched CIMD document (see cimd.ts). Duplicated
// here, not imported, because neither is part of this task's public export surface.
const CIMD_BYTE_CAP = 64 * 1024;
const CIMD_FETCH_TIMEOUT_MS = 3000;

// Silent by default so the no-cache warning does not spray stderr across every case, matching
// the convention in config.test.ts.
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof resolveConfig>[0]> = {}
): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
    fetchImpl,
    logger: silentLogger,
    ...overrides,
  });
}

// Builds a fresh Response per call rather than resolving the same instance every time -- a
// Response's body stream can only be read once, so a shared instance would break the moment any
// test drove two real fetches through the same fetchImpl (a confusing "body already used" error
// instead of a clear assertion failure).
function buildFetch(body: unknown, init: { status?: number } = {}): typeof fetch {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn().mockImplementation(
    async () =>
      new Response(text, {
        status: init.status ?? 200,
        headers: { "content-type": "application/json" },
      })
  ) as unknown as typeof fetch;
}

// Builds a fetch whose Response body is a ReadableStream delivered in separate chunks and
// carries no content-length header — the shape a chunked-transfer-encoding response actually
// takes. Proves the byte cap is enforced by counting bytes as they stream in, not by reading
// (or trusting the absence of) a Content-Length header.
function buildChunkedFetch(chunks: string[]): typeof fetch {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  return vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

// Like buildChunkedFetch, but enqueues one chunk per pull() call instead of all at once, and
// records every pull. Lets a test prove the reader was cancelled after the byte cap was hit —
// i.e. the stream was never drained to completion — rather than merely truncating the result
// after reading everything.
function buildLazyChunkedFetch(
  chunkText: string,
  chunkCount: number
): { fetchImpl: typeof fetch; pullCount: () => number } {
  let nextChunkIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (nextChunkIndex >= chunkCount) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunkText));
      nextChunkIndex += 1;
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
  return { fetchImpl, pullCount: () => nextChunkIndex };
}

// A real fetch ties the AbortSignal it's called with to the response body's stream, so aborting
// mid-download rejects a pending reader.read() -- that's how the fetch timeout is meant to reach a
// body that drips bytes without ever finishing. A mocked Response built independently of the
// signal doesn't get that behavior for free, so this fake wires it up by hand: its body stream
// never produces another chunk on its own, but rejects the pending pull() the moment the signal
// passed to fetchImpl aborts, mirroring what undici does for a real network response. Also reports
// whether it ever saw the abort, so a test can fail fast with a clear reason (instead of hanging
// for the full suite timeout) if a regression means the abort never reaches the body read.
function buildStalledBodyFetch(): { fetchImpl: typeof fetch; sawAbort: () => boolean } {
  let abortObserved = false;
  const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            abortObserved = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort);
          // Otherwise never settles -- simulates a server that stops sending bytes mid-response.
          void controller;
        });
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetchImpl, sawAbort: () => abortObserved };
}

// Simulates a fetchImpl whose Response exposes no readable body stream at all (body: null) —
// something a nonstandard or misbehaving fetch polyfill could return. There is deliberately no
// .text() on this fake: if the implementation ever fell back to an unbounded, uncapped read
// here, this test would throw a "response.text is not a function" error instead of the expected
// one, catching that regression directly.
function buildBodylessFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
  }) as unknown as typeof fetch;
}

// Same shape as buildBodylessFetch, but this one *does* implement .text() — spying on it so a
// test can assert it was never called. Reading the body via response.text() when there's no
// stream to cap is the exact vulnerable fallback this task was told to close off (it would
// buffer the full, unmeasured body before any size check could run). Asserting onText was never
// invoked proves that fallback path doesn't exist anymore, regardless of what it would have
// returned.
function buildBodylessFetchWithTextSpy(): { fetchImpl: typeof fetch; onText: ReturnType<typeof vi.fn> } {
  const onText = vi.fn().mockResolvedValue(JSON.stringify(CIMD_DOC));
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    text: onText,
  }) as unknown as typeof fetch;
  return { fetchImpl, onText };
}

function neverHitCache(): CacheStore {
  return {
    async get() {
      return null;
    },
    async set() {},
    async del() {},
    async getdel() {
      return null;
    },
  };
}

describe("isCimdClientId", () => {
  it("is true for an https URL", () => {
    expect(isCimdClientId(CIMD_URL)).toBe(true);
  });

  it("is false for an opaque registered client_id", () => {
    expect(isCimdClientId("abc123")).toBe(false);
  });
});

describe("resolveCimdClient", () => {
  it("fetches and returns the document", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    const doc = await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect(doc.redirect_uris).toEqual([REDIRECT_URI]);
  });

  it("serves the second call from the cache without refetching, even when storage would also miss", async () => {
    // resolveCimdClient checks storage before the network too, so a naive version of this test
    // (default storage, which now holds a row after the first call) would pass even if the cache
    // were completely broken -- storage alone would prevent the second fetch. Forcing
    // storage.findClient to always miss isolates the property this test's name actually claims:
    // the cache, specifically, is what serves the second call.
    const fetchImpl = buildFetch(CIMD_DOC);
    const storage = memoryStorage();
    storage.findClient = async () => null;
    const config = buildConfig(fetchImpl, { storage });
    await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("persists the fetched client so its name survives a cache flush", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect((await config.storage.findClient(CIMD_URL))?.clientName).toBe("Fetched Client");
  });

  it("rejects a non-https client_id", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    await expect(resolveCimdClient(config, "http://client.example/doc.json")).rejects.toThrow(/HTTPS/);
  });

  it("rejects a private-address host", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    await expect(resolveCimdClient(config, "https://127.0.0.1/doc.json")).rejects.toThrow(/private/);
  });

  it("rejects an IPv6 loopback literal host ([::1])", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    await expect(resolveCimdClient(config, "https://[::1]/doc.json")).rejects.toThrow(/private/);
  });

  it("rejects a hostname that resolves to a loopback address via DNS (localhost)", async () => {
    // Every other private-host test above uses a literal IP, which short-circuits before
    // dns.lookup() is ever called -- this is the guard's only coverage of the DNS-resolution
    // branch of assertPublicHost. Uses the real dns.lookup (no mocking): "localhost" resolves
    // locally without any network access, so this is not flaky.
    const config = buildConfig(buildFetch(CIMD_DOC));
    await expect(resolveCimdClient(config, "https://localhost/doc.json")).rejects.toThrow(/private/);
  });

  describe("SSRF guard: private, loopback, and reserved address families", () => {
    // Each row is an address family the guard must reject that a naive implementation (matching
    // on textual prefixes like "10." or "fe80:") is prone to missing -- particularly the last two,
    // which are the same private/link-local addresses smuggled through IPv6's IPv4-mapped notation
    // (the exact form WHATWG URL produces when a caller writes "[::ffff:127.0.0.1]").
    const RESERVED_ADDRESS_URLS: Array<[string, string]> = [
      ["0.0.0.0/8 (this network)", "https://0.0.0.0/doc.json"],
      ["IPv6 unspecified address (::)", "https://[::]/doc.json"],
      ["100.64.0.0/10 (carrier-grade NAT)", "https://100.64.0.1/doc.json"],
      ["fe80::/10 upper edge (link-local)", "https://[febf::1]/doc.json"],
      ["fec0::/10 (deprecated site-local)", "https://[fec0::1]/doc.json"],
      ["255.255.255.255 (broadcast, inside 240.0.0.0/4)", "https://255.255.255.255/doc.json"],
      ["224.0.0.0/4 (multicast)", "https://224.0.0.1/doc.json"],
      ["ff00::/8 (IPv6 multicast)", "https://[ff02::1]/doc.json"],
      ["240.0.0.0/4 (reserved)", "https://240.0.0.1/doc.json"],
      ["192.0.0.0/24 (IETF protocol assignments)", "https://192.0.0.1/doc.json"],
      ["198.18.0.0/15 (benchmarking)", "https://198.18.0.1/doc.json"],
      ["IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", "https://[::ffff:127.0.0.1]/doc.json"],
      ["IPv4-mapped IPv6 cloud-metadata address (::ffff:169.254.169.254)", "https://[::ffff:169.254.169.254]/doc.json"],
      ["NAT64-embedded cloud-metadata address (64:ff9b::a9fe:a9fe)", "https://[64:ff9b::a9fe:a9fe]/doc.json"],
      ["6to4-embedded loopback address (2002:7f00:1::)", "https://[2002:7f00:1::]/doc.json"],
    ];

    it.each(RESERVED_ADDRESS_URLS)("rejects %s", async (_description, url) => {
      const config = buildConfig(buildFetch(CIMD_DOC));
      await expect(resolveCimdClient(config, url)).rejects.toThrow(/private/);
    });

    // A blanket rule wide enough to catch every reserved family can just as easily be wide
    // enough to swallow legitimate public hosts too -- these are the regression guard for that.
    // (This is not a hypothetical: an earlier draft added a single net.BlockList subnet meant to
    // catch IPv4-mapped IPv6 literals and it silently rejected every public IPv4 host, this test
    // included, because of how net.BlockList normalizes an "ipv4" check against that subnet.)
    const PUBLIC_ADDRESS_URLS: Array<[string, string]> = [
      ["a public IPv4 host", "https://8.8.8.8/doc.json"],
      ["a public IPv6 host", "https://[2001:db8::1]/doc.json"],
      ["a public host in IPv4-mapped IPv6 notation", "https://[::ffff:8.8.8.8]/doc.json"],
      // These two are the direct regression guard for N2: a blanket rule over the whole
      // 64:ff9b::/96 or 2002::/16 prefix would reject these, since 8.8.8.8's embedded form is
      // just as much "inside" that prefix as 169.254.169.254's is. Extracting the embedded
      // address and reclassifying it is what tells them apart.
      ["a public host in NAT64 notation (64:ff9b::808:808 = 8.8.8.8)", "https://[64:ff9b::808:808]/doc.json"],
      ["a public host in 6to4 notation (2002:808:808:: = 8.8.8.8)", "https://[2002:808:808::]/doc.json"],
    ];

    it.each(PUBLIC_ADDRESS_URLS)("does not reject %s", async (_description, url) => {
      const config = buildConfig(buildFetch(CIMD_DOC));
      const doc = await resolveCimdClient(config, url);
      expect(doc.redirect_uris).toEqual([REDIRECT_URI]);
    });
  });

  it("rejects a non-200 response", async () => {
    const config = buildConfig(buildFetch("nope", { status: 404 }));
    await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/404/);
  });

  it("rejects a body that is not JSON", async () => {
    const config = buildConfig(buildFetch("<html>not json</html>"));
    await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/JSON/);
  });

  it("rejects a document with no redirect_uris", async () => {
    const config = buildConfig(buildFetch({ client_name: "No Redirects" }));
    await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/redirect_uris/);
  });

  it("rejects a document whose redirect_uris contains a cleartext http URI on a non-loopback host", async () => {
    // End-to-end proof that cimdDocumentSchema's validateRedirectUri refine actually reaches this
    // call site: a byte-identical DCR registration would be rejected by registerRequestSchema for
    // the same URI, so a CIMD document must not be able to smuggle it through unvalidated.
    const config = buildConfig(
      buildFetch({ client_name: "Bad Redirect", redirect_uris: ["http://attacker.example/cb"] })
    );
    await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/redirect_uris/);
  });

  it("does not follow redirects", async () => {
    const fetchImpl = buildFetch(CIMD_DOC);
    const config = buildConfig(fetchImpl);
    await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  describe("byte cap enforcement", () => {
    it("accepts a body exactly at the byte cap (rejected only by JSON.parse, proving the cap boundary is inclusive)", async () => {
      const bodyAtCap = "x".repeat(CIMD_BYTE_CAP);
      const config = buildConfig(buildFetch(bodyAtCap));
      // Not valid JSON, so a body that cleared the byte cap still fails downstream — this
      // isolates exactly where the boundary sits, independent of JSON well-formedness.
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/JSON/);
    });

    it("rejects a body one byte over the cap", async () => {
      const bodyOverCap = "x".repeat(CIMD_BYTE_CAP + 1);
      const config = buildConfig(buildFetch(bodyOverCap));
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/exceeds/);
    });

    it("a stream-bodied Response carries no content-length header (sanity check for the tests below)", () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
          controller.close();
        },
      });
      const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      expect(response.headers.get("content-length")).toBeNull();
    });

    it("rejects an oversized body delivered as multiple chunks with no content-length header", async () => {
      const fortyKilobyteChunk = "x".repeat(40 * 1024);
      const fetchImpl = buildChunkedFetch([fortyKilobyteChunk, fortyKilobyteChunk]); // 80KB total, cap is 64KB
      const config = buildConfig(fetchImpl);

      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/exceeds/);
    });

    it("rejects an oversized non-JSON body with the size error, not a JSON-parse error — proving the cap is checked before JSON.parse runs", async () => {
      const fortyKilobyteChunk = "not valid json ".repeat(40 * 1024 - 1).slice(0, 40 * 1024);
      const fetchImpl = buildChunkedFetch([fortyKilobyteChunk, fortyKilobyteChunk]);
      const config = buildConfig(fetchImpl);
      const error = await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true }).catch(
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/exceeds/);
      expect((error as Error).message).not.toMatch(/JSON/);
    });

    it("cancels the stream once the cap is exceeded instead of draining it to completion", async () => {
      const twentyKilobyteChunk = "x".repeat(20 * 1024);
      // 10 chunks are available (200KB total). The running total crosses the 64KB cap after the
      // 4th chunk (81920 bytes); the stream's own internal read-ahead can have already requested
      // one more chunk by the time reader.cancel() takes effect, so 4-5 pulls is the deterministic
      // "stopped early" range. What this test guards against is draining all 10 (200KB) — if the
      // cap weren't enforced by streaming, every chunk would be pulled before any rejection.
      const { fetchImpl, pullCount } = buildLazyChunkedFetch(twentyKilobyteChunk, 10);
      const config = buildConfig(fetchImpl);
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/exceeds/);
      expect(pullCount()).toBeGreaterThanOrEqual(4);
      expect(pullCount()).toBeLessThanOrEqual(5);
    });

    it("fails closed when the fetch response exposes no readable body stream", async () => {
      const config = buildConfig(buildBodylessFetch());
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/readable body/);
    });

    it("never falls back to an unbounded response.text() read when there is no body stream", async () => {
      const { fetchImpl, onText } = buildBodylessFetchWithTextSpy();
      const config = buildConfig(fetchImpl);
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/readable body/);
      expect(onText).not.toHaveBeenCalled();
    });
  });

  describe("fetch timeout", () => {
    // afterEach (not an in-test try/finally) restores real timers even if the test below times
    // out instead of failing a normal assertion -- vitest abandons the test body on timeout, so a
    // finally block inside it would never run, leaking fake timers into later tests.
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects a body that stalls mid-stream within the timeout, instead of hanging until the byte cap is reached", async () => {
      // Headers arrive immediately (the mocked Response resolves right away); the body then never
      // produces another byte on its own, staying well under the 64KB cap forever. Only the
      // timeout can end this -- proves the AbortController fires during the body read, not just
      // during the initial fetchImpl call.
      vi.useFakeTimers();
      const { fetchImpl, sawAbort } = buildStalledBodyFetch();
      const config = buildConfig(fetchImpl);
      const resolution = resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
      // Attach the rejection handler before advancing timers, not after -- resolution can reject
      // as soon as the timer fires, and attaching .rejects afterward leaves a window where it
      // rejects with nothing listening yet (an unhandled-rejection warning, even though the test
      // still passes overall).
      const assertion = expect(resolution).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(CIMD_FETCH_TIMEOUT_MS + 1);
      // Fails fast with a clear reason if the abort never reached the body read -- without this,
      // a regression here previously hung for the full suite timeout with no diagnostic.
      expect(sawAbort()).toBe(true);
      await assertion;
    });
  });

  // Documents (and pins) the consequence of OAuthStorage.upsertClient being insert-if-absent:
  // once a CIMD client's document has been fetched and stored once, resolveCimdClient never
  // fetches that URL live again on its own — a cache miss falls back to the storage row, not to
  // the network, forever. A legitimate redirect_uris rotation at the live URL is invisible until
  // the stored row is deleted out-of-band. This is deliberate per the brief and per upsertClient's
  // documented contract; not something this task changes.
  it("keeps serving the originally stored document forever, even after the live document changes and the cache is bypassed", async () => {
    const originalRedirectUri = "https://client.example/original-callback";
    const rotatedRedirectUri = "https://client.example/rotated-callback";
    const originalDoc = { client_name: "Rotating Client", redirect_uris: [originalRedirectUri] };
    const rotatedDoc = { client_name: "Rotating Client", redirect_uris: [rotatedRedirectUri] };

    const config = buildConfig(buildFetch(originalDoc), { cache: neverHitCache() });
    const firstResolution = await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect(firstResolution.redirect_uris).toEqual([originalRedirectUri]);

    const rotatedFetchImpl = buildFetch(rotatedDoc);
    config.fetchImpl = rotatedFetchImpl;
    const secondResolution = await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });

    expect(secondResolution.redirect_uris).toEqual([originalRedirectUri]);
    expect(rotatedFetchImpl).not.toHaveBeenCalled();
  });
});
