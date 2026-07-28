import type { OAuthStorage, ShopRef } from "../types";

/**
 * Removes the install gate: any merchant who completes Shopify's flow receives a token.
 * Shopify installs the app on approval, so finishing the flow does not prove prior install.
 * Only use this when the app genuinely keeps no per-shop record.
 */
export function allowAnyShop(): OAuthStorage["findShopByDomain"] {
  return async (domain: string): Promise<ShopRef | null> => ({ id: domain, domain });
}
