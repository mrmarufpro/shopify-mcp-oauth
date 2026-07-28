import { z } from "zod";

const TOKEN_TYPE_HINTS = ["access_token", "refresh_token"] as const;

function isTokenTypeHint(value: string): value is (typeof TOKEN_TYPE_HINTS)[number] {
  return (TOKEN_TYPE_HINTS as readonly string[]).includes(value);
}

// z.enum's own invalid_enum_value issue carries the received value verbatim, even with a custom
// message — the message is clean but the issue object still leaks it (e.g. via JSON.stringify(
// error.issues)). token_type_hint sits beside `token` and is the field most likely to receive a
// real token by client mistake, so validate it with a plain string + superRefine instead: a custom
// issue never carries `received`. Piping into z.enum recovers the narrowed literal type — the pipe's
// second stage never runs once the first has gone dirty, so the enum's leaky issue is unreachable.
const tokenTypeHintSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (!isTokenTypeHint(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "token_type_hint must be access_token or refresh_token",
      });
    }
  })
  .pipe(z.enum(TOKEN_TYPE_HINTS));

export const revokeRequestSchema = z.object({
  token: z.string({ required_error: "token is required" }).min(1, "token is required"),
  token_type_hint: tokenTypeHintSchema.optional(),
  client_id: z.string().optional(),
});
