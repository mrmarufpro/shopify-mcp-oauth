import type { ResolvedConfig } from "../config";
import { randomBase64Url, sha256Hex } from "../crypto";

const CODE_TTL_SECONDS = 60;
const CODE_PREFIX = "mcp:oauth:code:";

export interface CodeRecord {
  shopId: string | number;
  shopDomain: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
}

export async function issueCode(
  config: ResolvedConfig,
  input: CodeRecord & { ttlSeconds?: number }
): Promise<{ code: string }> {
  const code = randomBase64Url(32);
  const ttl = input.ttlSeconds ?? CODE_TTL_SECONDS;
  if (ttl > 0) {
    const record: CodeRecord = {
      shopId: input.shopId,
      shopDomain: input.shopDomain,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      resource: input.resource,
    };
    // Keyed by the code's own hash, not the code itself, so a cache dump never yields a redeemable code.
    await config.cache.set(`${CODE_PREFIX}${sha256Hex(code)}`, JSON.stringify(record), ttl);
  }
  return { code };
}

export async function consumeCode(config: ResolvedConfig, code: string): Promise<CodeRecord | null> {
  const key = `${CODE_PREFIX}${sha256Hex(code)}`;
  // getdel is atomic on every CacheStore; that's what keeps a code single-use when two /token
  // requests race on it concurrently.
  const raw = await config.cache.getdel(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CodeRecord;
  } catch {
    // A cache entry that isn't valid JSON can't be a code this package wrote; treat it the same
    // as "not found" rather than letting a corrupt entry crash the /token request.
    return null;
  }
}
