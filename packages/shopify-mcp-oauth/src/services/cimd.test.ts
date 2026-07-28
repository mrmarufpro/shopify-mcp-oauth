import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import type { CacheStore } from "../types";
import { isCimdClientId, resolveCimdClient } from "./cimd";

const CIMD_URL = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const CIMD_DOC = { client_name: "Fetched Client", redirect_uris: [REDIRECT_URI] };

// The package's byte cap on a fetched CIMD document (see cimd.ts). Duplicated here, not
// imported, because the cap isn't part of this task's public export surface.
const CIMD_BYTE_CAP = 64 * 1024;

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

function buildFetch(body: unknown, init: { status?: number } = {}): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
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

  it("serves the second call from cache without refetching", async () => {
    const fetchImpl = buildFetch(CIMD_DOC);
    const config = buildConfig(fetchImpl);
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
