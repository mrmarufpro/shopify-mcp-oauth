import type { RequestHandler, Response } from "express";
import type { ResolvedConfig } from "../config";
import { randomBase64Url } from "../crypto";
import { OAuthError } from "../errors";
import { authorizeQuerySchema } from "../schemas/authorize";
import { isCimdClientId, resolveCimdClient } from "../services/cimd";
import { redirectUriMatches } from "../services/redirectUri";
import { signOuterState } from "../services/stateJwt";
import { asyncHandler } from "./asyncHandler";

const STATE_TTL_SECONDS = 600;
const NONCE_BYTES = 16;

export interface AuthorizeControllerOptions {
  allowPrivateCimdHosts?: boolean;
}

function bad(res: Response, description: string, code = "invalid_request"): void {
  // Answered as a 400 rather than a redirect: bouncing to an unvalidated redirect_uri would
  // make /authorize an open redirector.
  res.status(400).json({ error: code, error_description: description });
}

export function authorizeController(config: ResolvedConfig, options: AuthorizeControllerOptions = {}): RequestHandler {
  return asyncHandler(config.logger, async (req, res) => {
    const parsed = authorizeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return bad(res, parsed.error.issues[0]?.message ?? "invalid query");
    }
    const query = parsed.data;

    const resource = query.resource ?? config.resource;
    if (resource !== config.resource) {
      return bad(res, `resource must equal ${config.resource}`);
    }

    let registeredRedirectUris: string[];
    if (isCimdClientId(query.client_id)) {
      try {
        const doc = await resolveCimdClient(config, query.client_id, {
          allowPrivateHosts: options.allowPrivateCimdHosts,
        });
        registeredRedirectUris = doc.redirect_uris;
      } catch (error) {
        // Only an OAuthError is a judgment about the client's own client_id/document — safe to
        // name on this unauthenticated endpoint. Anything else (e.g. the storage lookup inside
        // resolveCimdClient failing) is an infrastructure error and must fall through to
        // asyncHandler's generic 500 instead of reflecting internal detail into a 400 body.
        if (!(error instanceof OAuthError)) throw error;
        return bad(res, error.description, error.code);
      }
    } else {
      const client = await config.storage.findClient(query.client_id);
      if (!client) return bad(res, "unknown client_id", "invalid_client");
      registeredRedirectUris = client.redirectUris;
    }

    if (!registeredRedirectUris.some((registered) => redirectUriMatches(registered, query.redirect_uri))) {
      return bad(res, "redirect_uri not registered for this client");
    }

    const state = signOuterState(
      {
        clientId: query.client_id,
        redirectUri: query.redirect_uri,
        clientState: query.state,
        codeChallenge: query.code_challenge,
        codeChallengeMethod: query.code_challenge_method,
        resource,
        nonce: randomBase64Url(NONCE_BYTES),
      },
      config.stateSecret,
      STATE_TTL_SECONDS
    );

    const shopifyQuery = new URLSearchParams({
      response_type: "code",
      client_id: config.shopify.apiKey,
      redirect_uri: `${config.host}/oauth/shopify-callback`,
      scope: config.shopify.scopes,
      state,
    });

    // admin.shopify.com renders the shop picker, then replays this path against the shop the
    // merchant chooses. That picker is the consent step — shop ownership is the consent.
    const shopPicker = new URL("https://admin.shopify.com/");
    shopPicker.searchParams.set("redirect", `/oauth/authorize?${shopifyQuery.toString()}`);
    shopPicker.searchParams.set("no_redirect", "true");
    res.redirect(shopPicker.toString());
  });
}
