import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { detectIntent } from "../src/agent/intent.js";
import { runAgentLoop } from "../src/agent/loop.js";
import { loadConfig, saveConfig } from "../src/config/loader.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import type { ChatMessage, CommandAnalysisInput, FileEditInput, FileEditProposal, LLMProvider, LLMRequest, LLMResponse } from "../src/llm/provider.js";
import type { ProjectContext } from "../src/project/ProjectContext.js";
import { OpenAICompatibleProvider } from "../src/llm/openaiCompatible.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { createToolRegistry, ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/tool.js";
import type { AgentLoopEvent, AgentRuntimeContext } from "../src/agent/types.js";
import { PermissionManager, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
import { runPermissionCommand } from "../src/permission/commands.js";
import { permissionChoiceAt, movePermissionSelection, permissionOptions } from "../src/tui/permissionOptions.js";
import { permissionModeOptions, permissionModeOptionIndex } from "../src/tui/permissionModeOptions.js";
import { createInitialTuiState, tuiReducer } from "../src/tui/state.js";
import { diffLineColor, diffLineStyle, padDiffLine, parseDiffHeader } from "../src/tui/diffLines.js";
import { computeDiffLines, renderDiffLinesClustered, renderFileContentPreview } from "../src/tui/diffPreview.js";
import { editInputText, inputLineSegments } from "../src/tui/inputEditing.js";
import { resizableTranscriptMessages, splitTranscriptMessages } from "../src/tui/transcriptSplit.js";
import { formatToolDiffSummary } from "../src/tui/toolDiffSummary.js";
import { sessionEventsToMessages } from "../src/tui/sessionTranscript.js";
import { latestExpandableTranscript } from "../src/tui/transcriptViewer.js";
import { messageRowsForDisplay, separatorLine } from "../src/tui/components/MessageList.js";
import { headerDisplayText } from "../src/tui/components/Header.js";
import { commandActionPrefix, semanticLineStyle } from "../src/tui/components/MarkdownText.js";

class ScriptedProvider implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  private index = 0;

  constructor(private readonly responses: LLMResponse[]) {}

  async createResponse(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
      tools: request.tools.map((tool) => ({ ...tool }))
    });
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error("No scripted response.");
    return response;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    return messages.at(-1)?.content ?? "";
  }

  async analyzeCommandResult(input: CommandAnalysisInput): Promise<string> {
    return input.stdout;
  }

  async proposeFileEdit(_input: FileEditInput): Promise<FileEditProposal> {
    return { oldText: "", newText: "", explanation: "" };
  }
}

async function main(): Promise<void> {
  await testPlainAnswerCompletes();
  await testToolRegistryListsModelDefinitions();
  await testModelRequestIncludesToolJsonSchema();
  await testOpenAICompatibleSerializesToolJsonSchema();
  await testOpenAICompatibleLeavesMissingToolCallIdForAgentNormalization();
  await testResolveExecutionEmitsProgressAndToolResult();
  await testToolCallAddsToolResultToMessages();
  await testToolResultsFollowAssistantToolCallMessage();
  await testMissingToolCallIdGetsStableFallback();
  await testOpenAICompatibleSerializesAssistantToolCalls();
  await testConversationPersistsAcrossTurns();
  await testTuiToolCallsStayInTranscriptOrder();
  await testRunningToolMessagesStayLiveUntilUpdated();
  await testResizableTranscriptKeepsAllMessagesDynamic();
  await testMessageRowsUseCompactCodexStyleConversationLayout();
  await testMessageSeparatorUsesCurrentViewportWidth();
  await testHeaderHidesCurrentSessionId();
  await testPermissionPromptSelectionUsesArrowAndEnter();
  await testPermissionModeOptionsExposeThreeSelectableModes();
  await testPermissionModePersistsToConfig();
  await testGitDiffToolIsRegistered();
  await testGitDiffIntentUsesDedicatedTool();
  await testGitDiffResultKeepsLineBreaksForTui();
  await testGitDiffLongResultIsCollapsedWithFullTranscript();
  await testRunCommandLongResultShowsHeadOnlyWithFullTranscript();
  await testRunCommandFailureShowsStderrPreviewWithFullTranscript();
  await testRunCommandToolCallUsesCodexStyleActionLine();
  await testRunCommandSummaryUsesCodexStylePreview();
  await testLatestExpandableTranscriptUsesMostRecentFullContent();
  await testSessionReplayExpandableTranscriptKeepsFullContent();
  await testToolDiffSummaryPrefersDiffOverJson();
  await testTuiToolResultShowsDiffSummaryInsteadOfJson();
  await testReadFileResultShowsContentPreviewInsteadOfJson();
  await testReadFileLongResultIsCollapsedWithFullTranscript();
  await testSessionReplayShowsDiffSummaryInsteadOfJson();
  await testSessionReplayShowsCompactToolSummaries();
  await testSessionReplayHidesToolCallJsonAndDoesNotDuplicateReadTitle();
  await testWriteFileToolResultCarriesDiffPreview();
  await testKimiStyleDiffPreviewClustersChanges();
  await testKimiStyleDiffPreviewCarriesColorTokens();
  await testKimiStyleDiffPreviewSuppressesIncompleteTrailingDeletes();
  await testWriteToolCallShowsContentPreviewInsteadOfAddOnlyDiff();
  await testEditToolCallDoesNotDuplicateDiffPreviewAndResult();
  await testGitDiffResultUsesKimiStyleUnifiedDiffPreview();
  await testPermissionPromptUsesKimiStyleContentPreview();
  await testMarkdownTextStylesDiffLines();
  await testMarkdownTextStylesCommandSemanticLines();
  await testMarkdownTextDetectsOnlyLeadingToolActions();
  await testTuiComponentsUseThemeColorTokens();
  await testInputEditingSupportsCursorMovementAndDeletion();
  await testToolSchemaValidationFailureRecordsToolResultAndError();
  await testWriteFileDisplayBuildsPermissionDiff();
  await testPermissionManagerDefaultPolicy();
  await testPermissionCommandShowsModeOptions();
  await testPermissionManagerSessionAllowlist();
  await testPermissionManagerCommandAllowlist();
  await testDeniedToolCallReturnsDeniedResult();
  await testSessionToolGrantSkipsRepeatedPermissionPrompt();
  await testAbortSignalInterruptsLoop();
  await testMissingToolEmitsError();
}

async function testPlainAnswerCompletes(): Promise<void> {
  const provider = new ScriptedProvider([{ content: "hello" }]);
  const { context, cleanup } = await createContext(provider);
  try {
    const events = await collect(runAgentLoop("hi", context));
    assert.equal(events.some((event) => event.type === "assistant_message" && event.content === "hello"), true);
    assert.equal(events.at(-1)?.type, "done");
  } finally {
    await cleanup();
  }
}

async function testToolRegistryListsModelDefinitions(): Promise<void> {
  const registry = new ToolRegistry();
  registry.register({
    name: "defined_tool",
    description: "Definition test tool.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    },
    schema: z.object({ value: z.string() }),
    async execute(args: unknown): Promise<unknown> {
      return args;
    }
  });

  assert.deepEqual(registry.listDefinitions(), [{
    name: "defined_tool",
    description: "Definition test tool.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    }
  }]);
}

async function testModelRequestIncludesToolJsonSchema(): Promise<void> {
  const provider = new ScriptedProvider([{ content: "done" }]);
  const { context, cleanup } = await createContext(provider, [
    {
      name: "write_file",
      description: "Write test file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "Full file content." }
        },
        required: ["path", "content"],
        additionalProperties: false
      },
      schema: z.object({ path: z.string(), content: z.string() }),
      resolveExecution(args: unknown) {
        return {
          approvalRule: "write_file",
          async execute() {
            return args;
          }
        };
      }
    } as unknown as Tool
  ]);
  try {
    await collect(runAgentLoop("write a file", context));
    const toolDefinition = provider.requests[0]?.tools.find((tool) => tool.name === "write_file") as { parameters?: unknown } | undefined;
    assert.deepEqual(toolDefinition?.parameters, {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", description: "Full file content." }
      },
      required: ["path", "content"],
      additionalProperties: false
    });
  } finally {
    await cleanup();
  }
}

async function testOpenAICompatibleSerializesToolJsonSchema(): Promise<void> {
  const bodies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.test", model: "test-model" });
    await provider.createResponse({
      messages: [{ role: "user", content: "make a file" }],
      tools: [{
        name: "write_file",
        description: "Write file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
          additionalProperties: false
        }
      }],
      signal: undefined
    } as unknown as LLMRequest);
    const body = bodies[0] as { tools?: Array<{ function?: { parameters?: unknown } }> };
    assert.deepEqual(body.tools?.[0]?.function?.parameters, {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testOpenAICompatibleLeavesMissingToolCallIdForAgentNormalization(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            function: {
              name: "read_file",
              arguments: "{\"path\":\"README.md\"}"
            }
          }]
        }
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.test", model: "test-model" });
    const response = await provider.createResponse({
      messages: [{ role: "user", content: "read README" }],
      tools: [],
      signal: undefined
    });
    assert.equal(response.toolCalls?.[0]?.id, "");
    assert.deepEqual(response.toolCalls?.[0]?.args, { path: "README.md" });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testResolveExecutionEmitsProgressAndToolResult(): Promise<void> {
  const provider = new ScriptedProvider([
    { content: "", toolCalls: [{ id: "call-1", name: "progress_tool", args: { value: "ok" } }] },
    { content: "final" }
  ]);
  let resolved = false;
  const { context, cleanup } = await createContext(provider, [
    {
      name: "progress_tool",
      description: "Progress test tool.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false
      },
      schema: z.object({ value: z.string() }),
      resolveExecution(args: { value: string }) {
        resolved = true;
        return {
          description: `Testing ${args.value}`,
          display: { kind: "generic", summary: `progress ${args.value}` },
          approvalRule: "progress_tool",
          async execute({ onUpdate }) {
            onUpdate?.({ kind: "progress", text: "halfway", percent: 50 });
            return { output: args.value };
          }
        };
      }
    } as unknown as Tool
  ]);
  try {
    const events = await collect(runAgentLoop("use progress tool", context));
    assert.equal(resolved, true);
    assert.equal(events.some((event) => event.type === "tool_progress" && event.tool === "progress_tool" && event.update.text === "halfway"), true);
    assert.equal(events.some((event) => event.type === "tool_result" && event.tool === "progress_tool"), true);
    assert.equal(provider.requests.length, 2);
  } finally {
    await cleanup();
  }
}

async function testToolCallAddsToolResultToMessages(): Promise<void> {
  const provider = new ScriptedProvider([
    { content: "", toolCalls: [{ id: "call-1", name: "echo_tool", args: { value: "ok" } }] },
    { content: "final" }
  ]);
  const { context, cleanup } = await createContext(provider, [
    {
      name: "echo_tool",
      description: "Echo test tool.",
      schema: z.object({ value: z.string() }),
      async execute(args: unknown): Promise<unknown> {
        return args;
      }
    }
  ]);
  try {
    const events = await collect(runAgentLoop("use tool", context));
    assert.equal(events.some((event) => event.type === "tool_result" && event.tool === "echo_tool"), true);
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[1]?.messages.at(-1)?.role, "tool");
    assert.match(provider.requests[1]?.messages.at(-1)?.content ?? "", /ok/);
  } finally {
    await cleanup();
  }
}

async function testToolResultsFollowAssistantToolCallMessage(): Promise<void> {
  const provider = new ScriptedProvider([
    { content: "", toolCalls: [{ id: "call-1", name: "echo_tool", args: { value: "ok" } }] },
    { content: "final" }
  ]);
  const { context, cleanup } = await createContext(provider, [
    {
      name: "echo_tool",
      description: "Echo test tool.",
      schema: z.object({ value: z.string() }),
      async execute(args: unknown): Promise<unknown> {
        return args;
      }
    }
  ]);
  try {
    await collect(runAgentLoop("use tool", context));
    const secondRequestMessages = provider.requests[1]?.messages ?? [];
    const assistantToolCallIndex = secondRequestMessages.findIndex((message) => message.role === "assistant" && "toolCalls" in message);
    const toolResultIndex = secondRequestMessages.findIndex((message) => message.role === "tool" && message.toolCallId === "call-1");
    assert.notEqual(assistantToolCallIndex, -1);
    assert.notEqual(toolResultIndex, -1);
    assert.equal(assistantToolCallIndex < toolResultIndex, true);
  } finally {
    await cleanup();
  }
}

async function testMissingToolCallIdGetsStableFallback(): Promise<void> {
  const provider = new ScriptedProvider([
    { content: "", toolCalls: [{ id: "", name: "echo_tool", args: { value: "ok" } }] },
    { content: "final" }
  ]);
  const { context, cleanup } = await createContext(provider, [
    {
      name: "echo_tool",
      description: "Echo test tool.",
      schema: z.object({ value: z.string() }),
      async execute(args: unknown): Promise<unknown> {
        return args;
      }
    }
  ]);
  try {
    const events = await collect(runAgentLoop("use tool", context));
    const toolCall = events.find((event) => event.type === "tool_call");
    const toolResult = events.find((event) => event.type === "tool_result");
    assert.equal(toolCall?.type === "tool_call" ? toolCall.call.id : undefined, "tool-1-1");
    assert.equal(toolResult?.type === "tool_result" ? toolResult.toolCallId : undefined, "tool-1-1");
    const secondRequestMessages = provider.requests[1]?.messages ?? [];
    const assistantToolCall = secondRequestMessages.find((message) => message.role === "assistant" && message.toolCalls?.length);
    const toolMessage = secondRequestMessages.find((message) => message.role === "tool");
    assert.equal(assistantToolCall?.toolCalls?.[0]?.id, "tool-1-1");
    assert.equal(toolMessage?.toolCallId, "tool-1-1");
  } finally {
    await cleanup();
  }
}

async function testOpenAICompatibleSerializesAssistantToolCalls(): Promise<void> {
  const bodies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.test", model: "test-model" });
    await provider.createResponse({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "make a file" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "write_file", args: { path: "TwoSum.java", content: "class TwoSum {}" } }] },
        { role: "tool", toolCallId: "call-1", name: "write_file", content: "{\"path\":\"TwoSum.java\"}" }
      ],
      tools: [],
      signal: undefined
    });
    const body = bodies[0] as { messages?: Array<Record<string, unknown>> };
    assert.equal(body.messages?.[2]?.role, "assistant");
    assert.equal(Array.isArray(body.messages?.[2]?.tool_calls), true);
    assert.equal(body.messages?.[3]?.role, "tool");
    assert.equal(body.messages?.[3]?.tool_call_id, "call-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testConversationPersistsAcrossTurns(): Promise<void> {
  const provider = new ScriptedProvider([
    { content: "first answer" },
    { content: "second answer" }
  ]);
  const { context, cleanup } = await createContext(provider);
  Object.assign(context, { conversation: [] });
  try {
    await collect(runAgentLoop("first question", context));
    await collect(runAgentLoop("second question", context));
    const secondTurnMessages = provider.requests[1]?.messages ?? [];
    assert.equal(secondTurnMessages.some((message) => message.role === "user" && message.content.includes("first question")), true);
    assert.equal(secondTurnMessages.some((message) => message.role === "assistant" && message.content === "first answer"), true);
  } finally {
    await cleanup();
  }
}

async function testTuiToolCallsStayInTranscriptOrder(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, { type: "user.message", content: "first" });
  state = tuiReducer(state, { type: "assistant.completed", content: "answer 1" });
  state = tuiReducer(state, { type: "user.message", content: "second" });
  state = tuiReducer(state, { type: "tool.call.started", tool: "write_file", args: { path: "TwoSum.java" } });
  state = tuiReducer(state, { type: "tool.call.completed", tool: "write_file", result: { path: "TwoSum.java", bytes: 42, durationMs: 3 } });
  state = tuiReducer(state, { type: "assistant.completed", content: "answer 2" });

  const secondUserIndex = state.messages.findIndex((message) => message.role === "user" && message.content === "second");
  const toolIndex = state.messages.findIndex((message) => message.role === "system" && message.content.includes("Wrote TwoSum.java"));
  const secondAnswerIndex = state.messages.findIndex((message) => message.role === "assistant" && message.content === "answer 2");
  assert.equal(secondUserIndex < toolIndex, true);
  assert.equal(toolIndex < secondAnswerIndex, true);
}

async function testRunningToolMessagesStayLiveUntilUpdated(): Promise<void> {
  const messages = [
    { id: "user-1", role: "user" as const, content: "create file" },
    { id: "tool-message-write-1", role: "system" as const, content: "… ✏️ write_file: hello.txt" }
  ];
  const split = splitTranscriptMessages(messages, "running");
  assert.equal(split.staticMessages.length, 1);
  assert.equal(split.liveMessages.length, 1);
  assert.equal(split.liveMessages[0]?.id, "tool-message-write-1");
}

async function testResizableTranscriptKeepsAllMessagesDynamic(): Promise<void> {
  const messages = [
    { id: "user-1", role: "user" as const, content: "question" },
    { id: "assistant-1", role: "assistant" as const, content: "answer" },
    { id: "tool-message-write-1", role: "system" as const, content: "… write_file: hello.txt" }
  ];

  assert.deepEqual(resizableTranscriptMessages(messages), messages);
}

async function testMessageRowsUseCompactCodexStyleConversationLayout(): Promise<void> {
  const rows = messageRowsForDisplay([
    { id: "user-1", role: "user", content: "first question\nsecond line" },
    { id: "assistant-1", role: "assistant", content: "first answer\nsecond answer line" },
    { id: "user-2", role: "user", content: "next question" }
  ]);

  assert.deepEqual(rows.map((row) => row.type), [
    "message",
    "message",
    "spacer",
    "message",
    "message",
    "spacer",
    "separator",
    "message",
    "spacer"
  ]);
  assert.deepEqual(rows.filter((row) => row.type === "message").map((row) => ({
    role: row.message.role,
    content: row.message.content,
    prefix: row.prefix
  })), [
    { role: "user", content: "first question", prefix: "› " },
    { role: "user", content: "second line", prefix: "  " },
    { role: "assistant", content: "first answer", prefix: "" },
    { role: "assistant", content: "second answer line", prefix: "" },
    { role: "user", content: "next question", prefix: "› " }
  ]);
}

async function testMessageSeparatorUsesCurrentViewportWidth(): Promise<void> {
  assert.equal(separatorLine(4), "────");
  assert.equal(separatorLine(0), "─");
}

async function testHeaderHidesCurrentSessionId(): Promise<void> {
  assert.equal(headerDisplayText("20260626-161626-116d7b0e", "20260626-161626-116d7b0e"), undefined);
  assert.equal(headerDisplayText("current-session", "older-session"), "Viewing older-session");
}

async function testPermissionPromptSelectionUsesArrowAndEnter(): Promise<void> {
  assert.equal(permissionOptions.length, 3);
  assert.equal(permissionChoiceAt(0), "approve_once");
  assert.equal(movePermissionSelection(0, 1), 1);
  assert.equal(permissionChoiceAt(movePermissionSelection(0, 1)), "reject");
  assert.equal(movePermissionSelection(0, -1), 2);
  assert.equal(permissionChoiceAt(2), "approve_command");
}

async function testPermissionModeOptionsExposeThreeSelectableModes(): Promise<void> {
  assert.deepEqual(permissionModeOptions.map((option) => option.label), [
    "Ask for approval",
    "Approve for me",
    "Full Access"
  ]);
  assert.deepEqual(permissionModeOptions.map((option) => option.mode), ["ask", "auto", "full-access"]);
  assert.equal(permissionModeOptionIndex("full-access"), 2);
}

async function testPermissionModePersistsToConfig(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-permission-config-"));
  try {
    await saveConfig(workspaceRoot, defaultConfig);
    const config = await loadConfig(workspaceRoot);
    config.permission.mode = "full-access";
    await saveConfig(workspaceRoot, config);
    const reloaded = await loadConfig(workspaceRoot);
    assert.equal(reloaded.permission.mode, "full-access");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testGitDiffToolIsRegistered(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-git-diff-registry-"));
  try {
    const registry = createToolRegistry({ workspaceRoot, ignore: [] });
    assert.equal(registry.list().some((tool) => tool.name === "git_diff"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testGitDiffIntentUsesDedicatedTool(): Promise<void> {
  assert.equal(detectIntent("git diff").type, "git_diff");
  assert.equal(detectIntent("查看 git diff").type, "git_diff");
}

async function testGitDiffResultKeepsLineBreaksForTui(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "diff-1", tool: "git_diff", args: {} });
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "diff-1",
    tool: "git_diff",
    result: {
      output: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n context",
      durationMs: 1
    }
  });

  const message = state.messages.find((item) => item.id === "tool-message-diff-1");
  assert.match(message?.content ?? "", /\+1 -1 a\.ts/);
  assert.match(message?.content ?? "", /\n\s+1 - old\n\s+1 \+ new\n\s+2   context/);
  assert.equal(message?.content.includes("\\n-old\\n+new"), false);
}

async function testGitDiffLongResultIsCollapsedWithFullTranscript(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "diff-long", tool: "git_diff", args: {} });
  const bodyLines = Array.from({ length: 24 }, (_, index) => ` line ${String(index + 1)}`);
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "diff-long",
    tool: "git_diff",
    result: {
      output: [
        "diff --git a/src/example.ts b/src/example.ts",
        "@@ -1,24 +1,24 @@",
        ...bodyLines
      ].join("\n"),
      durationMs: 2
    }
  });

  const message = state.messages.find((item) => item.id === "tool-message-diff-long");
  assert.match(message?.content ?? "", /Viewed git diff/);
  assert.match(message?.content ?? "", /ctrl \+ t to view transcript/);
  assert.match(message?.content ?? "", /line 1/);
  assert.match(message?.content ?? "", /line 24/);
  assert.equal(message?.content.includes("line 13"), false);
  assert.match(message?.fullContent ?? "", /line 13/);
}

async function testRunCommandLongResultShowsHeadOnlyWithFullTranscript(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "run-long", tool: "run_command", args: { command: "pnpm test" } });
  const stdout = Array.from({ length: 16 }, (_, index) => `stdout ${String(index + 1)}`).join("\n");
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "run-long",
    tool: "run_command",
    result: {
      stdout,
      stderr: "",
      exitCode: 0,
      durationMs: 5
    }
  });

  const message = state.messages.find((item) => item.id === "tool-message-run-long");
  assert.match(message?.content ?? "", /Ran pnpm test/);
  assert.match(message?.content ?? "", /stdout:/);
  assert.match(message?.content ?? "", /exit 0/);
  assert.equal(message?.content.includes("$ pnpm test"), false);
  assert.match(message?.content ?? "", /stdout 1/);
  assert.match(message?.content ?? "", /stdout 4/);
  assert.equal(message?.content.includes("stdout 8"), false);
  assert.equal(message?.content.includes("stdout 16"), false);
  assert.match(message?.content ?? "", /ctrl \+ t to view transcript/);
  assert.match(message?.fullContent ?? "", /stdout 16/);
}

async function testRunCommandFailureShowsStderrPreviewWithFullTranscript(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "run-fail", tool: "run_command", args: { command: "pnpm broken" } });
  const stderr = Array.from({ length: 8 }, (_, index) => `stderr ${String(index + 1)}`).join("\n");
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "run-fail",
    tool: "run_command",
    result: {
      stdout: "stdout ok",
      stderr,
      exitCode: 2,
      durationMs: 7
    }
  });

  const message = state.messages.find((item) => item.id === "tool-message-run-fail");
  assert.match(message?.content ?? "", /Ran pnpm broken/);
  assert.match(message?.content ?? "", /exit 2/);
  assert.match(message?.content ?? "", /stdout:/);
  assert.match(message?.content ?? "", /stderr:/);
  assert.match(message?.content ?? "", /stderr 1/);
  assert.match(message?.content ?? "", /stderr 4/);
  assert.equal(message?.content.includes("stderr 8"), false);
  assert.match(message?.fullContent ?? "", /stderr 8/);
}

async function testRunCommandToolCallUsesCodexStyleActionLine(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, {
    type: "tool.call.started",
    toolCallId: "run-rg",
    tool: "run_command",
    args: { command: "rg -n \"tool|command\" src/tui tests 2>/dev/null" },
    display: { kind: "command", command: "rg -n \"tool|command\" src/tui tests 2>/dev/null" }
  });

  const message = state.messages.find((item) => item.id === "tool-message-run-rg");
  assert.match(message?.content ?? "", /^… 💻 Ran rg -n "tool\|command" src\/tui tests 2>\/dev\/null/);
  assert.equal(message?.content.includes("run_command:"), false);
  assert.equal(message?.content.includes("  $ "), false);
}

async function testRunCommandSummaryUsesCodexStylePreview(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, {
    type: "tool.call.started",
    toolCallId: "run-fail",
    tool: "run_command",
    args: { command: "pnpm test" },
    display: { kind: "command", command: "pnpm test" }
  });
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "run-fail",
    tool: "run_command",
    result: {
      stdout: Array.from({ length: 7 }, (_, index) => `stdout ${String(index + 1)}`).join("\n"),
      stderr: Array.from({ length: 3 }, (_, index) => `error ${String(index + 1)}`).join("\n"),
      exitCode: 2,
      durationMs: 31
    }
  });

  const message = state.messages.find((item) => item.id === "tool-message-run-fail");
  assert.match(message?.content ?? "", /^✗ 💻 Ran pnpm test/);
  assert.match(message?.content ?? "", /\n  exit 2/);
  assert.match(message?.content ?? "", /\nstderr:/);
  assert.match(message?.content ?? "", /error 1/);
  assert.equal(message?.content.includes("stdout 7"), false);
  assert.match(message?.content ?? "", /ctrl \+ t to view transcript/);
  assert.match(message?.fullContent ?? "", /stdout 7/);
}

async function testLatestExpandableTranscriptUsesMostRecentFullContent(): Promise<void> {
  const item = latestExpandableTranscript([
    { id: "one", role: "system", content: "short" },
    { id: "two", role: "system", content: "collapsed one", fullTitle: "First", fullContent: "first full" },
    { id: "three", role: "system", content: "collapsed two", fullTitle: "Second", fullContent: "second full" }
  ]);
  assert.deepEqual(item, { title: "Second", content: "second full" });
}

async function testSessionReplayExpandableTranscriptKeepsFullContent(): Promise<void> {
  const content = Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`).join("\n");
  const messages = sessionEventsToMessages("/workspace", "/workspace/.agent/sessions/session-1.jsonl", [
    {
      type: "tool_result",
      toolCallId: "read-1",
      tool: "read_file",
      result: {
        path: "README.md",
        content
      }
    }
  ] as SessionEvent[]);

  const item = latestExpandableTranscript(messages.map((message, index) => ({ id: `loaded-${String(index + 1)}`, ...message })));
  assert.deepEqual(item, { title: "Read README.md", content });
}

async function testToolDiffSummaryPrefersDiffOverJson(): Promise<void> {
  const summary = formatToolDiffSummary("write_file", {
    path: "hello.py",
    bytes: 22,
    diffPreview: "--- /dev/null\n+++ b/hello.py\n@@\n+print(\"Hello, world!\")"
  });

  assert.match(summary ?? "", /\+1 hello\.py/);
  assert.match(summary ?? "", /\n\s+1 \+ print\("Hello, world!"\)/);
  assert.equal(summary?.includes("\"bytes\""), false);
  assert.equal(summary?.includes("diffPreview"), false);
}

async function testToolDiffSummaryShowsLineNumberedHunks(): Promise<void> {
  const summary = formatToolDiffSummary("git_diff", {
    output: [
      "diff --git a/src/tui/sessionTranscript.ts b/src/tui/sessionTranscript.ts",
      "@@ -8,2 +8,3 @@",
      " import type { SessionEvent } from \"../session/recorder.js\";",
      "+import { formatToolDiffSummary } from \"./toolDiffSummary.js\";",
      " ",
      "@@ -48,1 +49,2 @@",
      "-      messages.push({ role: \"system\", content: `tool result: ${event.tool}` });",
      "+      messages.push({ role: \"system\", content: `tool result: ${event.tool}` });",
      "+      continue;"
    ].join("\n")
  });

  assert.match(summary ?? "", /\+3 -1 src\/tui\/sessionTranscript\.ts/);
  assert.match(summary ?? "", /\n\s+8   import type/);
  assert.match(summary ?? "", /\n\s+9 \+ import \{ formatToolDiffSummary \}/);
  assert.match(summary ?? "", /\n\s+48 -\s+messages\.push/);
  assert.match(summary ?? "", /\n\s+49 \+       messages\.push/);
  assert.match(summary ?? "", /\n\s+50 \+       continue/);
}

async function testTuiToolResultShowsDiffSummaryInsteadOfJson(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "write-1", tool: "write_file", args: { path: "hello.py" } });
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "write-1",
    tool: "write_file",
    result: {
      path: "hello.py",
      bytes: 22,
      diffPreview: "--- /dev/null\n+++ b/hello.py\n@@\n+print(\"Hello, world!\")",
      durationMs: 2
    }
  });

  const message = state.messages.find((item) => item.id === "tool-message-write-1");
  assert.match(message?.content ?? "", /\+1 hello\.py/);
  assert.match(message?.content ?? "", /\n\s+1 \+ print\("Hello, world!"\)/);
  assert.equal(message?.content.includes("\"bytes\""), false);
  assert.equal(message?.content.includes("result: {"), false);
}

async function testReadFileResultShowsContentPreviewInsteadOfJson(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "read-1", tool: "read_file", args: { path: "README.md" } });
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "read-1",
    tool: "read_file",
    result: {
      path: "README.md",
      content: "# Biny\nhello",
      durationMs: 2
    }
  });

  const message = state.messages.find((item) => item.id === "tool-message-read-1");
  assert.match(message?.content ?? "", /Read README\.md/);
  assert.match(message?.content ?? "", /# Biny/);
  assert.equal(message?.content.includes("\"content\""), false);
}

async function testReadFileLongResultIsCollapsedWithFullTranscript(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "read-long", tool: "read_file", args: { path: "README.md" } });
  const content = Array.from({ length: 20 }, (_, index) => `line ${String(index + 1)}`).join("\n");
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "read-long",
    tool: "read_file",
    result: {
      path: "README.md",
      content,
      durationMs: 2
    }
  });

  const message = state.messages.find((item) => item.id === "tool-message-read-long");
  assert.match(message?.content ?? "", /Read README\.md/);
  assert.match(message?.content ?? "", /line 1/);
  assert.match(message?.content ?? "", /line 6/);
  assert.equal(message?.content.includes("line 20"), false);
  assert.match(message?.content ?? "", /ctrl \+ t to view transcript/);
  assert.match(message?.fullContent ?? "", /line 20/);
}

async function testSessionReplayShowsDiffSummaryInsteadOfJson(): Promise<void> {
  const messages = sessionEventsToMessages("/workspace", "/workspace/.agent/sessions/session-1.jsonl", [
    {
      type: "tool_result",
      tool: "write_file",
      result: {
        path: "hello.py",
        bytes: 22,
        diffPreview: "--- /dev/null\n+++ b/hello.py\n@@\n+print(\"Hello, world!\")"
      }
    }
  ] as SessionEvent[]);
  const toolResult = messages.find((message) => message.content.includes("+1 hello.py"));

  assert.match(toolResult?.content ?? "", /\+1 hello\.py/);
  assert.equal(toolResult?.content.includes("\"bytes\""), false);
}

async function testSessionReplayShowsCompactToolSummaries(): Promise<void> {
  const messages = sessionEventsToMessages("/workspace", "/workspace/.agent/sessions/session-1.jsonl", [
    {
      type: "tool_result",
      tool: "run_command",
      result: {
        stdout: Array.from({ length: 8 }, (_, index) => `stdout ${String(index + 1)}`).join("\n"),
        stderr: "warning",
        exitCode: 1,
        durationMs: 3
      }
    },
    {
      type: "tool_result",
      tool: "read_file",
      result: {
        path: "README.md",
        content: Array.from({ length: 10 }, (_, index) => `line ${String(index + 1)}`).join("\n")
      }
    }
  ] as SessionEvent[]);

  const command = messages.find((message) => message.content.includes("Ran command"));
  assert.match(command?.content ?? "", /Ran command/);
  assert.match(command?.content ?? "", /stderr:/);
  assert.equal(command?.content.includes("stdout 8"), false);

  const read = messages.find((message) => message.content.includes("Read README.md"));
  assert.match(read?.content ?? "", /Read README\.md/);
  assert.match(read?.content ?? "", /line 1/);
  assert.equal(read?.content.includes("line 10"), false);
}

async function testSessionReplayHidesToolCallJsonAndDoesNotDuplicateReadTitle(): Promise<void> {
  const messages = sessionEventsToMessages("/workspace", "/workspace/.agent/sessions/session-1.jsonl", [
    {
      type: "tool_call",
      call: { id: "read-1", name: "read_file", args: { path: "README.md" } },
      tool: "read_file",
      args: { path: "README.md" },
      description: "Read README.md"
    },
    {
      type: "tool_result",
      toolCallId: "read-1",
      tool: "read_file",
      result: {
        path: "README.md",
        content: "line 1\nline 2"
      }
    }
  ] as SessionEvent[]);

  assert.equal(messages.some((message) => message.content.includes("tool call: read_file")), false);
  assert.equal(messages.some((message) => message.content.includes("\"path\"")), false);
  const read = messages.find((message) => message.content.includes("Read README.md"));
  assert.equal(read?.content.match(/Read README\.md/g)?.length, 1);
}

async function testWriteFileToolResultCarriesDiffPreview(): Promise<void> {
  const provider = new ScriptedProvider([
    { content: "", toolCalls: [{ id: "write-1", name: "write_file", args: { path: "hello.txt", content: "hello world\n" } }] },
    { content: "done" }
  ]);
  const { context, cleanup } = await createContext(provider, [
    {
      name: "write_file",
      description: "Write test file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false
      },
      schema: z.object({ path: z.string(), content: z.string() }),
      resolveExecution(args: { path: string; content: string }) {
        return {
          approvalRule: "write_file",
          async execute() {
            return { path: args.path, bytes: Buffer.byteLength(args.content, "utf8") };
          }
        };
      }
    } as unknown as Tool
  ]);
  try {
    const events = await collect(runAgentLoop("write file", context));
    const result = events.find((event) => event.type === "tool_result" && event.tool === "write_file")?.result as { contentPreview?: string; diffPreview?: string } | undefined;
    assert.match(result?.contentPreview ?? "", /Write hello\.txt/);
    assert.match(result?.contentPreview ?? "", /\n\s+1\s+hello world/);
    assert.equal(result?.diffPreview, undefined);
  } finally {
    await cleanup();
  }
}

async function testKimiStyleDiffPreviewClustersChanges(): Promise<void> {
  const lines = renderDiffLinesClustered(
    ["one", "keep before", "old", "same", "gap a", "gap b", "gap c", "tail"].join("\n"),
    ["one", "keep before", "new", "same", "gap a", "gap b", "gap c", "tail changed"].join("\n"),
    "src/example.ts",
    { contextLines: 1, maxLines: 10 }
  );

  assert.deepEqual(lines[0], {
    kind: "header",
    content: "+2 -2 src/example.ts",
    path: "src/example.ts",
    additions: 2,
    deletions: 2,
    style: { bold: true, additions: "diffAddedStrong", deletions: "diffRemovedStrong", path: "textStrong" }
  });
  assert.deepEqual(lines.map((line) => line.kind), ["header", "context", "delete", "add", "context", "meta", "context", "delete", "add"]);
  assert.equal(lines.some((line) => line.kind === "meta" && line.content.includes("unchanged line")), true);
  assert.equal(lines.some((line) => line.kind === "add" && line.content === "new" && line.lineNum === 3), true);
  assert.equal(lines.some((line) => line.kind === "delete" && line.content === "old" && line.lineNum === 3), true);
}

async function testKimiStyleDiffPreviewCarriesColorTokens(): Promise<void> {
  const lines = renderDiffLinesClustered("old\nsame", "new\nsame", "src/example.ts", { contextLines: 1 });
  assert.deepEqual(lines[0]?.style, { bold: true, additions: "diffAddedStrong", deletions: "diffRemovedStrong", path: "textStrong" });
  assert.deepEqual(lines.find((line) => line.kind === "delete")?.style, { gutter: "diffGutter", marker: "diffRemoved", content: "diffRemoved" });
  assert.deepEqual(lines.find((line) => line.kind === "add")?.style, { gutter: "diffGutter", marker: "diffAdded", content: "diffAdded" });
  assert.deepEqual(lines.find((line) => line.kind === "context")?.style, { gutter: "diffGutter", marker: "diffMeta", content: "textDim", dimColor: true });

  const contentPreview = renderFileContentPreview("src/new.ts", "one\ntwo", { maxLines: 1 });
  assert.deepEqual(contentPreview.find((line) => line.kind === "content")?.style, { gutter: "diffGutter", content: "text" });
  assert.deepEqual(contentPreview.find((line) => line.kind === "meta")?.style, { content: "diffMeta", dimColor: true });
}

async function testKimiStyleDiffPreviewSuppressesIncompleteTrailingDeletes(): Promise<void> {
  const lines = computeDiffLines("alpha\nbeta\ngamma", "alpha", 1, 1, true);
  assert.deepEqual(lines, [{ kind: "context", lineNum: 1, content: "alpha" }]);
}

async function testWriteToolCallShowsContentPreviewInsteadOfAddOnlyDiff(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, {
    type: "tool.call.started",
    toolCallId: "write-preview",
    tool: "write_file",
    args: { path: "hello.py", content: "print(\"hi\")\n" },
    display: { kind: "file_io", operation: "write", path: "hello.py", content: "print(\"hi\")\n" }
  });

  const message = state.messages.find((item) => item.id === "tool-message-write-preview");
  assert.match(message?.content ?? "", /Write hello\.py/);
  assert.match(message?.content ?? "", /\n\s+1\s+print\("hi"\)/);
  assert.equal(message?.content.includes("+ print"), false);
  assert.equal(message?.content.includes("--- /dev/null"), false);
}

async function testEditToolCallDoesNotDuplicateDiffPreviewAndResult(): Promise<void> {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "messages.cleared" });
  state = tuiReducer(state, {
    type: "tool.call.started",
    toolCallId: "edit-1",
    tool: "edit_file",
    args: { path: "hello.txt" },
    display: {
      kind: "file_io",
      operation: "edit",
      path: "hello.txt",
      before: "功能测试通过！",
      after: ""
    }
  });
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "edit-1",
    tool: "edit_file",
    result: {
      durationMs: 13,
      path: "hello.txt",
      diffPreview: ["--- a/hello.txt", "+++ b/hello.txt", "@@", "-功能测试通过！"].join("\n")
    }
  });

  const message = state.messages.at(-1);
  assert.equal(message?.content.match(/-1 hello\.txt/g)?.length, 1);
  assert.equal(message?.content.includes("--- a/hello.txt"), false);
}

async function testGitDiffResultUsesKimiStyleUnifiedDiffPreview(): Promise<void> {
  const summary = formatToolDiffSummary("git_diff", {
    output: [
      "diff --git a/src/example.ts b/src/example.ts",
      "@@ -1,6 +1,6 @@",
      " one",
      " keep before",
      "-old",
      "+new",
      " same",
      " gap a",
      " gap b",
      " gap c",
      " gap d",
      " gap e",
      " gap f",
      "-tail",
      "+tail changed"
    ].join("\n")
  });

  assert.match(summary ?? "", /\+2 -2 src\/example\.ts/);
  assert.match(summary ?? "", /\n\s+2\s+keep before/);
  assert.match(summary ?? "", /\n\s+3 - old/);
  assert.match(summary ?? "", /\n\s+3 \+ new/);
  assert.match(summary ?? "", /… 1 unchanged line …/);
  assert.equal(summary?.includes("Edited src/example.ts"), false);
}

async function testPermissionPromptUsesKimiStyleContentPreview(): Promise<void> {
  const provider = new ScriptedProvider([{ content: "unused" }]);
  const { context, cleanup } = await createContext(provider);
  try {
    const request = await createToolPermissionRequest(
      { id: "write-1", name: "write_file", args: { path: "new.py", content: "print(\"new\")\n" } },
      { workspaceRoot: context.workspaceRoot, ignore: context.config.workspace.ignore }
    );
    assert.match(request.details, /Write new\.py/);
    assert.match(request.details, /\n\s+1\s+print\("new"\)/);
    assert.equal(request.details.includes("--- /dev/null"), false);
    assert.equal(request.details.includes("+print"), false);
  } finally {
    await cleanup();
  }
}

async function testMarkdownTextStylesDiffLines(): Promise<void> {
  const expectedColors = {
    primary: "#4FA8FF",
    textStrong: "#F5F5F5",
    textDim: "#888888",
    diffAdded: "#4EC87E",
    diffRemoved: "#E85454",
    diffGutter: "#6B6B6B",
    diffMeta: "#888888"
  };
  assert.equal(diffLineColor("+new code"), expectedColors.diffAdded);
  assert.equal(diffLineColor("-old code"), expectedColors.diffRemoved);
  assert.equal(diffLineColor(" context"), undefined);
  assert.equal(diffLineColor("+++ b/file.ts"), undefined);
  assert.equal(diffLineColor("--- a/file.ts"), undefined);
  assert.deepEqual(diffLineStyle("  +new code"), { color: expectedColors.textStrong, backgroundColor: expectedColors.diffAdded, fillBackground: true });
  assert.deepEqual(diffLineStyle("  -old code"), { color: expectedColors.textStrong, backgroundColor: expectedColors.diffRemoved, fillBackground: true });
  assert.deepEqual(diffLineStyle("   9 + import code"), { color: expectedColors.diffAdded });
  assert.deepEqual(diffLineStyle("  48 - old code"), { color: expectedColors.diffRemoved });
  assert.deepEqual(diffLineStyle("   8    8   context"), { color: expectedColors.diffMeta, dimColor: true });
  assert.deepEqual(diffLineStyle("  --- a/file.ts"), { color: expectedColors.diffMeta, dimColor: true });
  assert.deepEqual(diffLineStyle("  Edited src/file.ts (+2 -1)"), { color: expectedColors.primary, bold: true });
  assertTuiDiffStylesAvoidNamedColors();
  assert.deepEqual(parseDiffHeader("Created hello.py (+1)"), { operation: "Created", path: "hello.py", additions: 1, deletions: undefined });
  assert.equal(padDiffLine("   9 + import code", 32), "   9 + import code");
}

async function testMarkdownTextStylesCommandSemanticLines(): Promise<void> {
  assert.deepEqual(semanticLineStyle("stdout:"), { color: "textStrong", bold: true });
  assert.deepEqual(semanticLineStyle("stderr:"), { color: "warning", bold: true });
  assert.deepEqual(semanticLineStyle("exit 0"), { color: "success", bold: true });
  assert.deepEqual(semanticLineStyle("  exit 0"), { color: "success", bold: true });
  assert.deepEqual(semanticLineStyle("exit 2"), { color: "error", bold: true });
  assert.deepEqual(semanticLineStyle("  exit 2"), { color: "error", bold: true });
  assert.deepEqual(semanticLineStyle("… 4 lines (ctrl + t to view transcript)"), { color: "textMuted" });
}

async function testMarkdownTextDetectsOnlyLeadingToolActions(): Promise<void> {
  assert.equal(commandActionPrefix("Ran rg -n \"tool\" src/tui"), "Ran");
  assert.equal(commandActionPrefix("Read README.md"), "Read");
  assert.equal(commandActionPrefix("Searched searching \"tool\""), "Searched");
  assert.equal(commandActionPrefix("tool result: run_command"), undefined);
  assert.equal(commandActionPrefix("The command Ran later"), undefined);
}

function assertTuiDiffStylesAvoidNamedColors(): void {
  const namedColors = new Set(["black", "white", "red", "green", "yellow", "gray", "grey", "cyan", "magenta", "blue"]);
  const styledLines = [
    "  +new code",
    "  -old code",
    "        9 + import code",
    "  48      - old code",
    "   8    8   context",
    "  --- a/file.ts",
    "  Edited src/file.ts (+2 -1)"
  ];
  for (const line of styledLines) {
    const style = diffLineStyle(line);
    const colorValues = [style?.color, style?.backgroundColor].filter((value): value is string => value !== undefined);
    assert.deepEqual(colorValues.filter((value) => namedColors.has(value)), [], `diff style uses named color for ${line}`);
  }
}

async function testTuiComponentsUseThemeColorTokens(): Promise<void> {
  const namedColorLiteral = /(["'])(black|white|red|green|yellow|gray|grey|cyan|magenta|blue)\1/g;
  const files = await typeScriptFiles(path.resolve("src/tui"));
  const violations: string[] = [];
  for (const file of files) {
    const relative = path.relative(process.cwd(), file);
    if (relative === path.join("src", "tui", "theme", "colors.ts")) continue;
    const source = await readFile(file, "utf8");
    source.split("\n").forEach((line, index) => {
      namedColorLiteral.lastIndex = 0;
      const matches = Array.from(line.matchAll(namedColorLiteral)).map((match) => match[2]).filter(Boolean);
      if (matches.length > 0) violations.push(`${relative}:${String(index + 1)} ${matches.join(", ")}`);
    });
  }
  assert.deepEqual(violations, []);
}

async function testInputEditingSupportsCursorMovementAndDeletion(): Promise<void> {
  let edit = editInputText({ text: "abcd", cursor: 4 }, { type: "move-left" });
  edit = editInputText(edit, { type: "move-left" });
  edit = editInputText(edit, { type: "insert", value: "X" });
  assert.deepEqual(edit, { text: "abXcd", cursor: 3 });

  edit = editInputText(edit, { type: "backspace" });
  assert.deepEqual(edit, { text: "abcd", cursor: 2 });
  edit = editInputText(edit, { type: "delete" });
  assert.deepEqual(edit, { text: "abd", cursor: 2 });

  edit = editInputText({ text: "first\nsecond", cursor: 9 }, { type: "line-start" });
  assert.deepEqual(edit, { text: "first\nsecond", cursor: 6 });
  assert.deepEqual(editInputText({ text: "\nnext", cursor: 0 }, { type: "line-start" }), { text: "\nnext", cursor: 0 });
  edit = editInputText(edit, { type: "line-end" });
  assert.deepEqual(edit, { text: "first\nsecond", cursor: 12 });
  edit = editInputText(edit, { type: "delete-before" });
  assert.deepEqual(edit, { text: "first\n", cursor: 6 });
  edit = editInputText({ text: "first\nsecond", cursor: 6 }, { type: "delete-after" });
  assert.deepEqual(edit, { text: "first\n", cursor: 6 });

  assert.deepEqual(inputLineSegments("one\ntwo", 5), [
    { before: "one", after: "", prefix: "> ", hasCursor: false },
    { before: "t", after: "wo", prefix: "  ", hasCursor: true }
  ]);
}

async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await typeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath);
    }
  }
  return files;
}

async function testToolSchemaValidationFailureRecordsToolResultAndError(): Promise<void> {
  let executed = false;
  const provider = new ScriptedProvider([
    { content: "", toolCalls: [{ id: "call-invalid", name: "strict_tool", args: { value: 123 } }] }
  ]);
  const recorder = new MemoryRecorder();
  const { context, cleanup } = await createContext(provider, [
    {
      name: "strict_tool",
      description: "Requires a string value.",
      schema: z.object({ value: z.string() }),
      async execute(): Promise<unknown> {
        executed = true;
        return { ok: true };
      }
    }
  ], { recorder: recorder.asSessionRecorder() });
  try {
    const events = await collect(runAgentLoop("use strict tool", context));
    assert.equal(executed, false);
    assert.equal(events.some((event) => event.type === "tool_result" && event.tool === "strict_tool" && hasValidationError(event.result)), true);
    assert.equal(events.some((event) => event.type === "error" && /invalid tool arguments/i.test(event.message)), true);
    assert.equal(recorder.events.some((event) => event.type === "tool_result" && event.tool === "strict_tool" && hasValidationError(event.result)), true);
    assert.equal(recorder.events.some((event) => event.type === "error" && /invalid tool arguments/i.test(event.message)), true);
  } finally {
    await cleanup();
  }
}

async function testWriteFileDisplayBuildsPermissionDiff(): Promise<void> {
  const provider = new ScriptedProvider([{ content: "unused" }]);
  const { context, cleanup } = await createContext(provider);
  try {
    await import("node:fs/promises").then((fs) => fs.writeFile(path.join(context.workspaceRoot, "note.txt"), "old\n", "utf8"));
    const request = await createToolPermissionRequest(
      { id: "write-1", name: "write_file", args: { path: "note.txt", content: "new\n" } },
      { workspaceRoot: context.workspaceRoot, ignore: context.config.workspace.ignore }
    );
    assert.equal(request.title, "File write request");
    assert.match(request.details, /File: note\.txt/);
    assert.match(request.details, /Bytes: 4/);
    assert.match(request.diff ?? "", /--- a\/note\.txt/);
    assert.match(request.diff ?? "", /\+\+\+ b\/note\.txt/);
    assert.match(request.diff ?? "", /@@/);
    assert.match(request.diff ?? "", /-old/);
    assert.match(request.diff ?? "", /\+new/);
  } finally {
    await cleanup();
  }
}

async function testPermissionManagerDefaultPolicy(): Promise<void> {
  const manager = new PermissionManager({
    mode: "ask",
    allowTools: ["read_file", "list_files", "search_files"],
    allowPaths: [],
    denyPaths: [".env", ".ssh/", "node_modules/"],
    criticalAlwaysAsk: true
  });

  assert.equal(manager.evaluate(permissionRequest({ toolName: "read_file", actionType: "read", riskLevel: "low", targetPath: "README.md" })).decision, "allow");
  assert.equal(manager.evaluate(permissionRequest({ toolName: "git_diff", actionType: "git", riskLevel: "low" })).decision, "allow");
  assert.equal(manager.evaluate(permissionRequest({ toolName: "write_file", actionType: "write", riskLevel: "medium", targetPath: "src/new.ts" })).decision, "ask");
  assert.equal(manager.evaluate(permissionRequest({ toolName: "run_command", actionType: "shell", riskLevel: "medium", command: "pnpm typecheck" })).decision, "ask");

  manager.setMode("read-only");
  const readOnlyWrite = manager.evaluate(permissionRequest({ toolName: "write_file", actionType: "write", riskLevel: "medium", targetPath: "src/new.ts" }));
  assert.equal(readOnlyWrite.decision, "deny");
  assert.match(readOnlyWrite.reason, /read only/i);

  manager.setMode("full-access");
  const criticalCommand = manager.evaluate(permissionRequest({ toolName: "run_command", actionType: "shell", riskLevel: "critical", command: "sudo rm -rf /" }));
  assert.equal(criticalCommand.decision, "ask");
  assert.match(criticalCommand.reason, /critical/i);
}

async function testPermissionCommandShowsModeOptions(): Promise<void> {
  const manager = new PermissionManager({
    mode: "ask",
    allowTools: [],
    allowPaths: [],
    denyPaths: [],
    criticalAlwaysAsk: true
  });
  const output = runPermissionCommand(manager, []);

  assert.match(output, /Permission levels/i);
  assert.match(output, /Read Only/i);
  assert.match(output, /Ask Before Write/i);
  assert.match(output, /Auto Allow Safe Tools/i);
  assert.match(output, /Full Access/i);
  assert.match(output, /\/permissions readonly/);
  assert.match(output, /\/permissions ask/);
  assert.match(output, /\/permissions full/);

  const switched = runPermissionCommand(manager, ["full"]);
  assert.equal(switched, "Permission mode switched to Full Access.");
  assert.equal(switched.includes("Session allowed tools"), false);
}

async function testPermissionManagerSessionAllowlist(): Promise<void> {
  const manager = new PermissionManager({
    mode: "ask",
    allowTools: [],
    allowPaths: [],
    denyPaths: [".env"],
    criticalAlwaysAsk: true
  });
  const request = permissionRequest({ toolName: "write_file", actionType: "write", riskLevel: "medium", targetPath: "src/generated.ts" });

  assert.equal(manager.evaluate(request).decision, "ask");
  manager.applyResult(request, { approved: true, scope: "tool" });
  assert.equal(manager.evaluate(request).decision, "allow");

  const denied = permissionRequest({ toolName: "read_file", actionType: "read", riskLevel: "critical", targetPath: ".env" });
  assert.equal(manager.evaluate(denied).decision, "deny");
}

async function testPermissionManagerCommandAllowlist(): Promise<void> {
  const manager = new PermissionManager({
    mode: "ask",
    allowTools: [],
    allowPaths: [],
    denyPaths: [],
    criticalAlwaysAsk: true
  });
  const firstCommand = permissionRequest({ toolName: "run_command", actionType: "shell", riskLevel: "medium", command: "pnpm typecheck" });
  const secondCommand = permissionRequest({ toolName: "run_command", actionType: "shell", riskLevel: "medium", command: "pnpm test" });

  assert.equal(manager.evaluate(firstCommand).decision, "ask");
  manager.applyResult(firstCommand, { approved: true, scope: "command" });
  assert.equal(manager.evaluate(firstCommand).decision, "allow");
  assert.equal(manager.evaluate(secondCommand).decision, "ask");
}

async function testDeniedToolCallReturnsDeniedResult(): Promise<void> {
  let executed = false;
  const provider = new ScriptedProvider([
    { content: "", toolCalls: [{ id: "write-denied", name: "write_file", args: { path: "blocked.txt", content: "nope" } }] },
    { content: "safe alternative" }
  ]);
  const { context, cleanup } = await createContext(provider, [
    {
      name: "write_file",
      description: "Write test file.",
      schema: z.object({ path: z.string(), content: z.string() }),
      async execute(): Promise<unknown> {
        executed = true;
        return { ok: true };
      }
    }
  ], {
    confirmPermission: async () => ({ approved: false, scope: "once" })
  });
  try {
    const events = await collect(runAgentLoop("write file", context));
    assert.equal(executed, false);
    assert.equal(events.some((event) => event.type === "tool_result" && event.tool === "write_file" && hasDeniedResult(event.result)), true);
    assert.equal(provider.requests.length, 2);
    assert.match(provider.requests[1]?.messages.at(-1)?.content ?? "", /denied/i);
  } finally {
    await cleanup();
  }
}

async function testSessionToolGrantSkipsRepeatedPermissionPrompt(): Promise<void> {
  let confirmCount = 0;
  let executeCount = 0;
  const provider = new ScriptedProvider([
    {
      content: "",
      toolCalls: [
        { id: "run-1", name: "run_command", args: { command: "pnpm typecheck" } },
        { id: "run-2", name: "run_command", args: { command: "pnpm test" } }
      ]
    },
    { content: "done" }
  ]);
  const { context, cleanup } = await createContext(provider, [
    {
      name: "run_command",
      description: "Run test command.",
      schema: z.object({ command: z.string() }),
      async execute(): Promise<unknown> {
        executeCount += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    }
  ], {
    confirmPermission: async () => {
      confirmCount += 1;
      return { approved: true, scope: "tool" };
    }
  });
  try {
    await collect(runAgentLoop("run checks", context));
    assert.equal(confirmCount, 1);
    assert.equal(executeCount, 2);
  } finally {
    await cleanup();
  }
}

async function testAbortSignalInterruptsLoop(): Promise<void> {
  const provider = new ScriptedProvider([{ content: "never" }]);
  const controller = new AbortController();
  controller.abort();
  const { context, cleanup } = await createContext(provider, [], { abortSignal: controller.signal });
  try {
    const events = await collect(runAgentLoop("stop", context));
    assert.equal(events.some((event) => event.type === "error" && /interrupted/i.test(event.message)), true);
  } finally {
    await cleanup();
  }
}

async function testMissingToolEmitsError(): Promise<void> {
  const provider = new ScriptedProvider([
    { content: "", toolCalls: [{ id: "missing-1", name: "missing_tool", args: {} }] },
    { content: "handled missing tool" }
  ]);
  const { context, cleanup } = await createContext(provider);
  try {
    const events = await collect(runAgentLoop("missing", context));
    assert.equal(events.some((event) => event.type === "error" && /unknown tool/i.test(event.message)), true);
    assert.equal(events.some((event) => event.type === "tool_result" && event.toolCallId === "missing-1" && event.tool === "missing_tool"), true);
    assert.equal(provider.requests.length, 2);
    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
    assert.equal(toolMessage?.toolCallId, "missing-1");
    assert.match(toolMessage?.content ?? "", /unknown tool/i);
  } finally {
    await cleanup();
  }
}

async function collect(iterable: AsyncGenerator<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function createContext(provider: LLMProvider, tools: Tool[] = [], overrides: Partial<AgentRuntimeContext> = {}): Promise<{ context: AgentRuntimeContext; cleanup: () => Promise<void> }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-agent-loop-"));
  await ensureAgentDirs(workspaceRoot);
  const recorder = new SessionRecorder(workspaceRoot);
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const context: AgentRuntimeContext = {
    workspaceRoot,
    config: defaultConfig as AgentConfig,
    llm: provider,
    recorder,
    projectContext: createProjectContext(workspaceRoot),
    toolRegistry: registry,
    confirmPermission: async () => ({ approved: true, scope: "once" }),
    ...overrides
  };
  return {
    context,
    cleanup: async () => {
      await recorder.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

class MemoryRecorder {
  readonly events: SessionEvent[] = [];

  asSessionRecorder(): SessionRecorder {
    return {
      sessionId: "memory-session",
      filePath: "memory-session.jsonl",
      record: (event: SessionEvent) => {
        this.events.push(event);
      },
      close: async () => {}
    } as unknown as SessionRecorder;
  }
}

function hasValidationError(result: unknown): boolean {
  return typeof result === "object"
    && result !== null
    && "validation" in result
    && result.validation === true
    && "error" in result
    && typeof result.error === "string";
}

function hasDeniedResult(result: unknown): boolean {
  return typeof result === "object"
    && result !== null
    && "status" in result
    && result.status === "denied";
}

function permissionRequest(overrides: Partial<PermissionRequestContext>): PermissionRequestContext {
  return {
    toolName: "read_file",
    actionType: "read",
    riskLevel: "low",
    reason: "test",
    sessionId: "test-session",
    projectRoot: "/tmp/project",
    ...overrides
  };
}

function createProjectContext(cwd: string): ProjectContext {
  return {
    cwd,
    packageManager: "unknown",
    srcTree: [],
    gitStatus: ""
  };
}

await main();
