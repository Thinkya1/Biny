/**
 * CLI 的 SIGINT 协作取消。
 *
 * 单独抽出来是为了能在测试里传入伪造的信号源，不去动真实 `process`。
 */

/** 只依赖 SIGINT 的一次性监听能力，方便测试替换。 */
export interface SigintSource {
  once(event: "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGINT", listener: () => void): unknown;
}

/**
 * 把操作期间收到的第一个 SIGINT 转成 AbortSignal，交给被包裹的操作自己收尾。
 * 监听器是一次性的且在 finally 里移除，否则会泄漏到后续对话轮次，导致下一轮一开始就被取消。
 */
export async function withCliAbortSignal<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  source: SigintSource = process
): Promise<T> {
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort(new Error("Operation interrupted by SIGINT."));
  };
  source.once("SIGINT", interrupt);
  try {
    const result = await execute(controller.signal);
    // 操作可能忽略了 signal 正常返回，这里补一次判断，保证中断过就一定以异常收场。
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("Operation interrupted by SIGINT.");
    }
    return result;
  } finally {
    source.removeListener("SIGINT", interrupt);
  }
}
