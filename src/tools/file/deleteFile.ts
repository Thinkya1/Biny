/** Safely deletes one regular workspace file after binding its prepared inode. */
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import {
  deleteBoundRegularFile,
  sameOptionalFileSnapshot,
  snapshotRegularFile
} from "./safeFileIo.js";

export interface DeleteFileArgs {
  path: string;
}

export interface DeleteFileResult {
  path: string;
  deleted: true;
}

export function createDeleteFileTool(context: ToolContext): Tool<DeleteFileArgs, DeleteFileResult> {
  return {
    name: "delete_file",
    description: "Delete one regular file inside the workspace. Directories and symbolic links are rejected.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative regular file path to delete." }
      },
      required: ["path"],
      additionalProperties: false
    },
    schema: z.object({ path: z.string().min(1) }),
    capability: "filesystem.delete",
    risk: "write",
    async resolveExecution(args) {
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
      const preparedSnapshot = await snapshotRegularFile(absolutePath);
      return {
        accesses: ToolAccesses.writeFile(absolutePath),
        display: { kind: "file_io", operation: "edit", path: args.path, detail: "delete regular file" },
        description: `Delete ${args.path}`,
        approvalRule: `delete_file(${args.path})`,
        async execute({ signal, approvedFile }) {
          signal?.throwIfAborted();
          const currentPath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
          if (currentPath !== absolutePath) throw new Error("The delete target changed after the tool call was prepared.");
          if (approvedFile && approvedFile.path !== absolutePath) {
            throw new Error("The approved delete target does not match the prepared tool target.");
          }
          if (approvedFile && !sameOptionalFileSnapshot(approvedFile.snapshot, preparedSnapshot)) {
            throw new Error("The delete target changed before permission approval.");
          }
          await deleteBoundRegularFile(absolutePath, preparedSnapshot, signal);
          return { path: args.path, deleted: true };
        }
      };
    }
  };
}
