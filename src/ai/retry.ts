export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Retries only transport/transient HTTP failures; successful or client-error responses pass through. */
export function createRetryFetch(policy: RetryPolicy, baseFetch: typeof fetch = fetch): typeof fetch {
  const maxAttempts = Math.max(1, Math.min(6, Math.floor(policy.maxAttempts)));
  const initialDelayMs = Math.max(0, policy.initialDelayMs);
  const maxDelayMs = Math.max(initialDelayMs, policy.maxDelayMs);
  return async (input, init) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await baseFetch(input, init);
        if (!retryableStatuses.has(response.status) || attempt === maxAttempts) return response;
      } catch (error) {
        if (attempt === maxAttempts) throw error;
      }
      init?.signal?.throwIfAborted();
      await delay(Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1)), init?.signal ?? undefined);
    }
    throw new Error("Provider request retry loop ended unexpectedly.");
  };
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
