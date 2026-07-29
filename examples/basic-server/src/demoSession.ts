export interface DemoOfflineSession {
  id: string;
  shop: string;
  state: string;
  isOnline: false;
  scope: string;
  accessToken: string;
}

/**
 * The install gate only asks whether an offline session with an access token exists for the shop,
 * so a placeholder token is enough for local development. A real install replaces this row.
 */
export function buildDemoOfflineSession(shopDomain: string, scope: string): DemoOfflineSession {
  return {
    id: `offline_${shopDomain}`,
    shop: shopDomain,
    state: "seeded",
    isOnline: false,
    scope,
    accessToken: "seeded-placeholder-token",
  };
}
