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
      // ShopifySessionStorageLike is structural, so the return type is not enforced at runtime.
      if (!Array.isArray(sessions)) {
        return null;
      }
      // The shop check is not redundant with querying by domain: a custom session-store wrapper
      // that filters loosely would otherwise let one shop's grant authorize another's. Only an
      // offline session proves an app-level grant — online sessions are per-staff-member.
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
