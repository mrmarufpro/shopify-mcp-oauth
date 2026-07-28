import type { NewOAuthClient, NewToken, OAuthClient, OAuthStorage, ShopRef, StoredToken } from "../types";

interface PrismaDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  upsert?(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  updateMany?(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

/**
 * Structural, so the adapter never imports `@prisma/client`. Declared as two named members
 * rather than an index signature: a real `PrismaClient` carries `$connect`/`$transaction`,
 * which a `Record<string, PrismaDelegate>` would reject.
 */
export interface PrismaLikeClient {
  mcpOAuthClient: PrismaDelegate;
  mcpOAuthToken: PrismaDelegate;
}

export interface PrismaShopMapping {
  model: string;
  domainField: string;
  idField: string;
  where?: Record<string, unknown>;
}

function toClient(row: Record<string, unknown>): OAuthClient {
  return {
    clientId: row.clientId as string,
    clientName: (row.clientName as string | null) ?? null,
    redirectUris: row.redirectUris as string[],
    grantTypes: (row.grantTypes as string[] | null) ?? null,
    responseTypes: (row.responseTypes as string[] | null) ?? null,
    logoUri: (row.logoUri as string | null) ?? null,
    clientUri: (row.clientUri as string | null) ?? null,
    tokenEndpointAuthMethod: (row.tokenEndpointAuthMethod as string) ?? "none",
    revokedAt: (row.revokedAt as Date | null) ?? null,
  };
}

function toToken(row: Record<string, unknown>): StoredToken {
  return {
    id: String(row.id),
    shopId: row.shopId as string | number,
    shopDomain: row.shopDomain as string,
    clientId: row.clientId as string,
    accessTokenHash: row.accessTokenHash as string,
    refreshTokenHash: (row.refreshTokenHash as string | null) ?? null,
    accessTokenExpiresAt: row.accessTokenExpiresAt as Date,
    refreshTokenExpiresAt: (row.refreshTokenExpiresAt as Date | null) ?? null,
    scope: (row.scope as string | null) ?? null,
    resource: (row.resource as string | null) ?? null,
    revokedAt: (row.revokedAt as Date | null) ?? null,
    rotatedFromId: (row.rotatedFromId as string | null) ?? null,
  };
}

function buildCore(prisma: PrismaLikeClient): Omit<OAuthStorage, "findShopByDomain"> {
  return {
    async findClient(clientId) {
      const row = await prisma.mcpOAuthClient.findFirst({ where: { clientId, revokedAt: null } });
      return row ? toClient(row) : null;
    },

    async createClient(client: NewOAuthClient) {
      const row = await prisma.mcpOAuthClient.create({ data: { ...client } });
      return toClient(row);
    },

    async upsertClient(client: NewOAuthClient) {
      if (!prisma.mcpOAuthClient.upsert) {
        throw new Error("prisma client delegate does not support upsert");
      }
      const row = await prisma.mcpOAuthClient.upsert({
        where: { clientId: client.clientId },
        create: { ...client },
        update: {},
      });
      return toClient(row);
    },

    async createToken(token: NewToken) {
      const row = await prisma.mcpOAuthToken.create({ data: { ...token } });
      return toToken(row);
    },

    async findTokenByAccessHash(hash) {
      const row = await prisma.mcpOAuthToken.findFirst({
        where: { accessTokenHash: hash, revokedAt: null, accessTokenExpiresAt: { gt: new Date() } },
      });
      return row ? toToken(row) : null;
    },

    async findTokenByRefreshHash(hash) {
      const row = await prisma.mcpOAuthToken.findFirst({
        where: { refreshTokenHash: hash, revokedAt: null, refreshTokenExpiresAt: { gt: new Date() } },
      });
      return row ? toToken(row) : null;
    },

    async revokeToken(id) {
      if (!prisma.mcpOAuthToken.updateMany) {
        throw new Error("prisma token delegate does not support updateMany");
      }
      // Conditional update: only the request that flips revokedAt from null wins, so two
      // concurrent refreshes cannot each mint a new pair.
      const result = await prisma.mcpOAuthToken.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count > 0;
    },

    async touchToken(id, lastUsedAt) {
      await prisma.mcpOAuthToken.updateMany?.({ where: { id }, data: { lastUsedAt } });
    },
  };
}

export function prismaStorage(prisma: PrismaLikeClient): Omit<OAuthStorage, "findShopByDomain">;
export function prismaStorage(prisma: PrismaLikeClient, opts: { shop: PrismaShopMapping }): OAuthStorage;
export function prismaStorage(
  prisma: PrismaLikeClient,
  opts?: { shop: PrismaShopMapping }
): OAuthStorage | Omit<OAuthStorage, "findShopByDomain"> {
  const core = buildCore(prisma);
  if (!opts) return core;

  const mapping = opts.shop;
  return {
    ...core,
    async findShopByDomain(domain): Promise<ShopRef | null> {
      const delegate = (prisma as unknown as Record<string, PrismaDelegate | undefined>)[mapping.model];
      if (!delegate) throw new Error(`prisma client has no "${mapping.model}" model`);
      const row = await delegate.findFirst({
        where: { ...(mapping.where ?? {}), [mapping.domainField]: domain },
      });
      if (!row) return null;
      return { id: row[mapping.idField] as string | number, domain };
    },
  };
}
