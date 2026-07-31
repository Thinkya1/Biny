/**
 * provider 请求重试。
 *
 * 以「包一层 fetch」的方式实现，provider transport 统一复用，也方便测试注入
 * 假 fetch。
 */
export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

// 只重试限流和网关类错误；4xx 里的参数/鉴权错误重试也不会变好。
const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 只重试传输层和临时性 HTTP 失败，成功响应与客户端错误直接透传。 */
export function createRetryFetch(policy: RetryPolicy, baseFetch: typeof fetch = fetch): typeof fetch {
  // 次数和延迟都收敛到合理区间，避免配置写错导致长时间卡住或无限重试。
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
      // 退避前先检查取消，避免用户已中断还白等一轮。
      init?.signal?.throwIfAborted();
      await delay(Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1)), init?.signal ?? undefined);
    }
    throw new Error("Provider request retry loop ended unexpectedly.");
  };
}

/** 可被取消的等待：定时器和 abort 监听互相清理，不留悬挂的 timer 或监听器。 */
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
