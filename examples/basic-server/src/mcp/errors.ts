export const ERROR_CODES = {
  NOT_AUTHENTICATED: "NOT_AUTHENTICATED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  DOWNSTREAM_ERROR: "DOWNSTREAM_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ToolErrorContent {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

export class McpToolError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }

  toContent(): ToolErrorContent {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ code: this.code, message: this.message, details: this.details }, null, 2),
        },
      ],
      isError: true,
    };
  }
}
