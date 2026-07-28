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

    const shop = await config.storage.findShopByDomain(query.shop);
    if (!shop) {
      // Shopify installs the app on approval, so reaching this point does not prove the shop was
      // ever a customer. This lookup is the only install gate.
      res
        .status(403)
        .type("text/plain")
        .send(`${query.shop} has not installed this app. Install it first, then connect again.`);
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
