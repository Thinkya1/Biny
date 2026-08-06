/**
 * 会话生命周期清理。
 *
 * 一个会话的事实、目录索引和运行旁路状态分散在不同文件中；删除只能从这里走，避免只删掉
 * JSONL 后留下 catalog、断点或历史 run 继续出现在列表和恢复流程里。
 */
import { deleteSessionCatalogRecord } from "./catalog.js";
import { deleteInterruptedTurn } from "./turnStore.js";
import { SessionRunLedger } from "./runLedger.js";
import { deleteSessionFile } from "./store.js";

export async function deleteSessionArtifacts(persistenceRoot: string, sessionId: string): Promise<void> {
  await deleteSessionFile(persistenceRoot, sessionId);
  await deleteSessionCatalogRecord(persistenceRoot, sessionId);
  await deleteInterruptedTurn(persistenceRoot, sessionId);
  await new SessionRunLedger(persistenceRoot).deleteSessionRuns(sessionId);
}
