import type { OAuthStorage, ShopRef } from "../types";

/**
 * Removes the install gate: any merchant who completes Shopify's flow receives a token.
 *
 * Completing that flow does install the app -- Shopify grants it on approval. What it doesn't do is
 * leave the host with any record of the shop, since this package's callback received the grant and
 * discards the Shopify token. So this admits merchants who never went through the host's own
 * install, whatever that does (an offline session, billing, webhooks). Only use it when the app
 * genuinely keeps no per-shop record at all.
 */
export function allowAnyShop(): OAuthStorage["findShopByDomain"] {
  return async (domain: string): Promise<ShopRef | null> => ({ id: domain, domain });
}
