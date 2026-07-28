import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { safeEqual } from "../crypto";

// Shopify signs the raw, URL-encoded query string it sent. Rebuilding the message from decoded
// values (req.query) re-encodes reserved characters differently and produces a mismatched base
// string, so this always works from the raw string Express received (req.originalUrl), never
// from req.query.
export function verifyShopifyHmac(queryString: string, secret: string): boolean {
  const pairs = queryString.split("&").filter(Boolean);
  let provided: string | undefined;
  const rest: string[] = [];
  for (const pair of pairs) {
    if (pair.startsWith("hmac=")) {
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
  if (!provided) return false;
  const computed = crypto.createHmac("sha256", secret).update(rest.join("&")).digest("hex");
  return safeEqual(provided, computed);
}

export function requireShopifyHmac(secret: string): RequestHandler {
  return (req, res, next) => {
    const queryString = req.originalUrl.split("?")[1] ?? "";
    if (!verifyShopifyHmac(queryString, secret)) {
      res.status(400).type("text/plain").send("invalid hmac");
      return;
    }
    next();
  };
}
