import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { shopifyCallbackQuerySchema } from "../schemas/shopifyCallback";
import { issueCode } from "../services/codes";
import { verifyOuterState, type VerifiedOuterState } from "../services/stateJwt";
import { asyncHandler } from "./asyncHandler";

export function shopifyCallbackController(config: ResolvedConfig): RequestHandler {
  return asyncHandler(config.logger, async (req, res) => {
    const parsed = shopifyCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .type("text/plain")
        .send(parsed.error.issues[0]?.message ?? "invalid query");
      return;
    }
    const query = parsed.data;

    let state: VerifiedOuterState;
    try {
      state = verifyOuterState(query.state, config.stateSecret);
    } catch {
      res.status(400).type("text/plain").send("invalid or expired state");
      return;
    }

    let exchange: Response;
    try {
      exchange = await config.fetchImpl(`https://${query.shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: config.shopify.apiKey,
          client_secret: config.shopify.apiSecret,
          code: query.code,
        }),
      });
    } catch {
      // Fixed text, not the caught error's message: a raw network error can carry connection-
      // level detail about how *we* tried to reach Shopify, not a judgment about the merchant's
      // own request. Classifying it as a 400 here still matches how resolveCimdClient treats its
      // own fetch failures (see services/cimd.ts) -- "we couldn't complete the exchange" is as
      // safe to say as any of the checks below.
      res.status(400).type("text/plain").send("shopify token exchange could not be completed");
      return;
    }
    if (!exchange.ok) {
      res.status(400).type("text/plain").send(`shopify exchange returned ${exchange.status}`);
      return;
    }

    let accessToken: string | undefined;
    try {
      accessToken = ((await exchange.json()) as { access_token?: string }).access_token;
    } catch {
      accessToken = undefined;
    }
    // The token is only ever proof that this merchant controls this shop. We do not keep it.
    if (!accessToken) {
      res.status(400).type("text/plain").send("shopify exchange returned no access token");
      return;
    }

    // A miss here is not necessarily "not a customer": under Shopify's managed install the app is
    // granted without the merchant ever opening it, so a host whose record is written when the
    // merchant first opens the embedded app legitimately has nothing yet. onShopNotFound is that
    // host's chance to write it -- typically the offline session, all the Shopify app template
    // keeps. It gets the access token because storing that session (and any Shopify call the
    // host's own install would make) needs it, and nothing else in this flow could supply it.
    const shop =
      (await config.storage.findShopByDomain(query.shop)) ??
      (await config.onShopNotFound?.({ domain: query.shop, accessToken })) ??
      null;
    if (!shop) {
      // Reaching here does NOT mean the app is uninstalled -- Shopify grants it on approval, so by
      // now it is installed. What's missing is the host's own record of the shop: this callback,
      // not the host's, received the grant, and the Shopify token is discarded rather than stored,
      // so nothing the host's install flow normally writes (an offline session at minimum) exists.
      // The message must therefore not say "install it" -- that is what the merchant just did, and
      // repeating it sends them in a circle with no way out.
      res
        .status(403)
        .type("text/plain")
        .send(
          `This app is not set up for ${query.shop}. Open it in your Shopify admin to finish setup, then try again.`
        );
      return;
    }

    // `query.shop` is the only shop identity in this request that anything actually verified: the
    // HMAC guard proved Shopify signed it (see middlewares/verifyShopifyHmac.ts), and the token
    // exchange above proved the merchant controls it. `shop.domain` is whatever the storage adapter
    // or the onShopNotFound hook handed back, and a hook is ordinary host code that can return a
    // ShopRef for a different shop entirely -- a lookup keyed on the wrong column, a normalization
    // that silently matched a neighbouring row. Binding the authorization code to that unchecked
    // value would issue this merchant a token scoped to another merchant's shop, which is exactly
    // what the HMAC check exists to make impossible. Compared case-insensitively so an adapter that
    // stores the canonical casing still passes; a genuine mismatch is a host bug, and refusing the
    // login is the only safe answer to it.
    if (shop.domain.toLowerCase() !== query.shop.toLowerCase()) {
      config.logger.error("shopify-mcp-oauth: shop lookup returned a different domain than the callback named", {
        callbackShop: query.shop,
        resolvedShop: shop.domain,
      });
      res.status(500).type("text/plain").send("shop resolution returned a different shop; login refused");
      return;
    }

    const { code } = await issueCode(config, {
      shopId: shop.id,
      shopDomain: shop.domain,
      clientId: state.clientId,
      redirectUri: state.redirectUri,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: state.codeChallengeMethod,
      resource: state.resource,
    });

    const target = new URL(state.redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state.clientState);
    res.redirect(target.toString());
  });
}
