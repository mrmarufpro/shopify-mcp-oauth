export class OAuthError extends Error {
  readonly code: string;
  readonly description: string;
  readonly status: number;

  constructor(code: string, description: string, status = 400) {
    super(`${code}: ${description}`);
    this.name = "OAuthError";
    this.code = code;
    this.description = description;
    this.status = status;
  }

  toBody(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
