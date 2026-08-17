export interface RetryOptions {
  /** Total attempts, including the first. Defaults to 3. */
  attempts?: number;
}

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  if (attempts < 1) {
    throw new Error(`retry needs at least one attempt, but was given ${attempts}.`);
  }
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (thrown) {
      lastError = thrown;
    }
  }

  throw lastError;
}
