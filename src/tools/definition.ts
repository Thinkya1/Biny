/**
 * 模型可见工具定义类型。
 *
 * ToolRegistry 负责从 Tool 契约投影出这组字段，AI SDK tool adapter 只消费这个 wire shape，
 * 避免模型 provider 反向参与工具注册逻辑。
 */
import type { JsonObjectSchema } from "./schema.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObjectSchema;
}
