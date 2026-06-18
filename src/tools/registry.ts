import type { ToolContext } from "./types.js";
import { createReadFileTool } from "./file/readFile.js";
import { createWriteFileTool } from "./file/writeFile.js";
import { createEditFileTool } from "./file/editFile.js";
import { createListFilesTool } from "./file/listFiles.js";
import { createGrepSearchTool } from "./search/grepSearch.js";
import { createRunCommandTool } from "./shell/runCommand.js";
import { createGitStatusTool } from "./git/status.js";
import { createGitDiffTool } from "./git/diff.js";

export function createTools(context: ToolContext) {
  return {
    readFile: createReadFileTool(context),
    writeFile: createWriteFileTool(context),
    editFile: createEditFileTool(context),
    listFiles: createListFilesTool(context),
    grepSearch: createGrepSearchTool(context),
    runCommand: createRunCommandTool(context),
    gitStatus: createGitStatusTool(context),
    gitDiff: createGitDiffTool(context)
  };
}
