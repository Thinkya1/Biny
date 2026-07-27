/**
 * 模型引用解析：支持配置 alias，也支持 `provider/model-id` 形式的实时目录引用。
 */
import type { ModelRegistry, RegisteredModel } from "./ModelRegistry.js";

export class ModelResolver {
  constructor(private readonly registry: ModelRegistry) {}

  resolve(reference: string, options: { requireAvailable?: boolean } = {}): RegisteredModel {
    const normalized = reference.trim();
    if (!normalized) throw new Error("Model reference cannot be empty.");
    const resolved = this.registry.resolve(normalized);
    if (!resolved) throw new Error(`Unknown model "${normalized}". Use a configured alias or provider/model-id.`);
    if (options.requireAvailable && !this.registry.isAvailable(resolved)) {
      throw new Error(`Model "${normalized}" is not available: configure its endpoint and credentials first.`);
    }
    return resolved;
  }
}
