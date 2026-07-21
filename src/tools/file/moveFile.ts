/** Safely moves one prepared regular workspace file without replacing a destination. */
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import {
  moveBoundRegularFile,
  sameFileSnapshot,
  snapshotRegularFile
} from "./safeFileIo.js";

export interface MoveFileArgs {
  from: string;
  to: string;
}

export interface MoveFileResult {
  from: string;
  to: string;
  moved: true;
}

export function createMoveFileTool(context: ToolContext): Tool<MoveFileArgs, MoveFileResult> {
  return {
    name: "move_file",
    description: "Move one regular UTF-8 workspace file to a new path without replacing an existing destination.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", minLength: 1, description: "Workspace-relative source file path." },
        to: { type: "string", minLength: 1, description: "Workspace-relative destination file path; it must not already exist." }
      },
      required: ["from", "to"],
      additionalProperties: false
    },
    schema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    capability: "filesystem.move",
    risk: "write",
    async resolveExecution(args) {
      const sourcePath = resolveWorkspacePath(context.workspaceRoot, args.from, context.ignore);
      const destinationPath = resolveWorkspacePath(context.workspaceRoot, args.to, context.ignore);
      const preparedSnapshot = await snapshotRegularFile(sourcePath);
      return {
        accesses: [
          ...ToolAccesses.writeFile(sourcePath),
          ...ToolAccesses.writeFile(destinationPath)
        ],
        display: {
          kind: "file_io",
          operation: "edit",
          path: args.from,
          detail: `move to ${args.to}`
        },
        description: `Move ${args.from} to ${args.to}`,
        approvalRule: `move_file(${args.from} -> ${args.to})`,
        async execute({ signal, approvedFile }) {
          signal?.throwIfAborted();
          const currentSource = resolveWorkspacePath(context.workspaceRoot, args.from, context.ignore);
          const currentDestination = resolveWorkspacePath(context.workspaceRoot, args.to, context.ignore);
          if (currentSource !== sourcePath || currentDestination !== destinationPath) {
            throw new Error("The move target changed after the tool call was prepared.");
          }
          if (approvedFile && approvedFile.path !== sourcePath) {
            throw new Error("The approved move source does not match the prepared target.");
          }
          const currentSnapshot = await snapshotRegularFile(sourcePath, signal);
          const expectedSnapshot = approvedFile?.snapshot ?? preparedSnapshot;
          if (expectedSnapshot === null || !sameFileSnapshot(currentSnapshot, expectedSnapshot)) {
            throw new Error("The move source changed before permission approval.");
          }
          await moveBoundRegularFile(sourcePath, destinationPath, expectedSnapshot, signal);
          return { from: args.from, to: args.to, moved: true };
        }
      };
    }
  };
}
