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
    let sessions: ShopifySessionLike[];
    try {
      sessions = await sessionStorage.findSessionsByShop(domain);
    } catch {
      // A session-store outage must read as "not installed", never as "installed".
      return null;
    }
    // Only an offline session proves an app-level grant; online sessions are per-staff-member.
    const offline = sessions.find((session) => !session.isOnline && Boolean(session.accessToken));
    return offline ? { id: domain, domain } : null;
  };
}
