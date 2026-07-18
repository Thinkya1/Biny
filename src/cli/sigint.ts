export interface SigintSource {
  once(event: "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGINT", listener: () => void): unknown;
}

/**
 * Turns the first SIGINT received during a CLI operation into cooperative
 * cancellation. The one-shot listener is always removed when the operation
 * settles, so it cannot leak into a later chat turn.
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
