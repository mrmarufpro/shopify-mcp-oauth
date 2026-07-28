import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { safeEqual } from "../crypto";

// Shopify signs the raw, URL-encoded query string it sent. Rebuilding the message from decoded
// values (req.query) re-encodes reserved characters differently and produces a mismatched base
// string, so this always works from the raw string Express received (req.originalUrl), never
// from req.query.
//
// The remaining parameters are sorted by key before hashing. Shopify's docs state this
// explicitly for the *installation-request* HMAC ("the remaining parameters must be sorted
// alphabetically as strings, in the format parameter_name=parameter_value") but this module
// verifies the *OAuth callback* HMAC, a different request whose own doc section only says "the
// hmac is valid and signed by Shopify" and defers to a library -- it doesn't restate an
// algorithm. Shopify's own shopify-api-js library uses one shared, always-sorted code path for
// both requests, and there's no separate order-preserving scheme documented or implemented
// anywhere, so this reads the callback's terse wording as shorthand for the installation
// request's algorithm, not an unspecified alternative -- and sorts here too. For this endpoint's
// fixed field set (code, hmac, host, shop, state, timestamp), Shopify's actual send order already
// is alphabetical, so this has no effect on real traffic today -- but that's a property of this
// field set, not something documented, so don't rely on it: sort explicitly rather than trust
// received order to keep coinciding as fields change.
function pairKey(pair: string): string {
  const separatorIndex = pair.indexOf("=");
  return separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
}

export function verifyShopifyHmac(queryString: string, secret: string): boolean {
  const pairs = queryString.split("&").filter(Boolean);
  let provided: string | undefined;
  let hmacPairCount = 0;
  const rest: string[] = [];
  for (const pair of pairs) {
    if (pair.startsWith("hmac=")) {
      hmacPairCount += 1;
      try {
        provided = decodeURIComponent(pair.slice("hmac=".length));
      } catch {
        // A malformed percent-encoding in the hmac param can't be a digest Shopify produced;
        // fail closed rather than letting decodeURIComponent's throw escape this function.
        return false;
      }
    } else {
      rest.push(pair);
    }
  }
  // Shopify never sends more than one hmac parameter. Every "hmac=" pair is stripped from the
  // signing base regardless of how many there are, so a query smuggling a second one would
  // otherwise still hash correctly as long as *some* pair happens to carry the genuine value --
  // reject outright instead of silently picking one (the loop above keeps the last).
  if (hmacPairCount !== 1 || !provided) return false;

  // Sort by key, not by the whole "key=value" string: the documented algorithm sorts
  // parameters, and sorting whole pairs only coincidentally agrees once values differ in ways
  // that could shift the comparison. The key is sliced off with indexOf("=") -- never decoded --
  // so the sort itself never re-encodes a byte of what it's ordering. A plain code-unit
  // comparison, not localeCompare: localeCompare's result depends on the host's ICU/locale data,
  // which has no business affecting a signature check that must agree byte-for-byte with a
  // remote party. For Shopify's ASCII parameter names the two agree, so this is strictly safer
  // with no behavioral downside. Array.prototype.sort is spec-guaranteed stable, so pairs sharing
  // a key keep their received relative order.
  const sorted = [...rest].sort((left, right) => {
    const leftKey = pairKey(left);
    const rightKey = pairKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  const computed = crypto.createHmac("sha256", secret).update(sorted.join("&")).digest("hex");
  return safeEqual(provided, computed);
}

export function requireShopifyHmac(secret: string): RequestHandler {
  return (req, res, next) => {
    // req.originalUrl can legally contain more than one "?": RFC 3986's query component allows
    // an unescaped "?", so a signed value like state=a?b puts a second "?" in the URL that isn't
    // a delimiter. String.prototype.split("?") doesn't know that -- it splits on *every* "?", and
    // [1] only ever returns the segment between the first and second one. That's wrong in both
    // directions: it truncates (and so rejects) a legitimate callback whose value contains "?",
    // and it lets an attacker append unsigned parameters after an injected second "?" that this
    // check then never sees, even though Express's own req.query -- built from everything after
    // the *first* "?" -- parses them anyway. Slicing from the first occurrence is the only way to
    // recover the exact same query string Express itself parses.
    const separatorIndex = req.originalUrl.indexOf("?");
    const queryString = separatorIndex === -1 ? "" : req.originalUrl.slice(separatorIndex + 1);
    if (!verifyShopifyHmac(queryString, secret)) {
      res.status(400).type("text/plain").send("invalid hmac");
      return;
    }
    next();
  };
}
