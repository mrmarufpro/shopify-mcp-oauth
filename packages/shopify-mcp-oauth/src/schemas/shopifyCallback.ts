import { z } from "zod";

// Constrain the shop to Shopify's own domain so a forged `shop` cannot redirect the
// server-to-server token exchange at an attacker-controlled host.
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const shopifyCallbackQuerySchema = z.object({
  shop: z.string().regex(SHOP_DOMAIN, "shop must be a myshopify.com domain"),
  code: z.string().min(1, "code is required"),
  state: z.string().min(1, "state is required"),
  hmac: z.string().min(1, "hmac is required"),
  host: z.string().optional(),
  timestamp: z.string().optional(),
});
