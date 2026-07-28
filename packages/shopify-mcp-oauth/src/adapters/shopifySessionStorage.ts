import type { OAuthStorage, ShopRef } from "../types";

export interface ShopifySessionLike {
  shop: string;
  isOnline: boolean;
  accessToken?: string;
}

export interface ShopifySessionStorageLike {
  findSessionsByShop(shop: string): Promise<ShopifySessionLike[]>;
}

export function shopifySessionStorage(sessionStorage: ShopifySessionStorageLike): OAuthStorage["findShopByDomain"] {
  return async (domain: string): Promise<ShopRef | null> => {
    try {
      const sessions = await sessionStorage.findSessionsByShop(domain);
      // Validate the response is an array before using array methods.
      if (!Array.isArray(sessions)) {
        return null;
      }
      // Only an offline session proves an app-level grant; online sessions are per-staff-member.
      // Verify the session belongs to the queried domain.
      const offline = sessions.find(
        (session) => session.shop === domain && !session.isOnline && Boolean(session.accessToken)
      );
      return offline ? { id: domain, domain } : null;
    } catch {
      // A session-store outage must read as "not installed", never as "installed".
      return null;
    }
  };
}
