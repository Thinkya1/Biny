/**
 * 模型可声明、完成门可读取的回合级状态。
 *
 * 这里不做完成判断，只保存结构化 blocked 原因和显式验证命令。每个新根回合都会 reset；
 * Completion Gate continuation 仍属于同一回合，因此不会清掉。
 */
import type { BlockedState, StructuredVerificationCheck } from "./completionGate.js";

export class CompletionStateStore {
  private blocked: BlockedState | undefined;
  private checks: StructuredVerificationCheck[] = [];

  reset(): void {
    this.blocked = undefined;
    this.checks = [];
  }

  /** 用户显式恢复 blocked 终态时，先移除旧阻塞；验证要求仍属于同一回合，继续保留。 */
  clearBlocked(): void {
    this.blocked = undefined;
  }

  reportBlocked(state: BlockedState): BlockedState {
    this.blocked = {
      ...state,
      affectedTodoIds: state.affectedTodoIds === undefined ? undefined : [...state.affectedTodoIds]
    };
    return this.getBlocked()!;
  }

  getBlocked(): BlockedState | undefined {
    return this.blocked === undefined
      ? undefined
      : {
        ...this.blocked,
        affectedTodoIds: this.blocked.affectedTodoIds === undefined ? undefined : [...this.blocked.affectedTodoIds]
      };
  }

  replaceChecks(checks: readonly StructuredVerificationCheck[]): StructuredVerificationCheck[] {
    this.checks = checks.map((check) => ({ ...check }));
    return this.listChecks();
  }

  listChecks(): StructuredVerificationCheck[] {
    return this.checks.map((check) => ({ ...check }));
  }
}
