/**
 * TUI 底部状态栏组件。
 *
 * 状态栏用一行展示当前模型标签、工作区路径，以及 plan 模式提示。它接收已经整理好的展示字段，
 * 不直接读取 runtime 或配置文件。
 */
import React from "react";
import { Box, Text } from "ink";
import { tuiColors } from "../theme/index.js";

export interface StatusBarProps {
  mode: "chat" | "plan";
  cwd: string;
  modelLabel: string;
}

export function StatusBar({ mode, cwd, modelLabel }: StatusBarProps): React.ReactElement {
  // 状态栏保持单行：左侧模型和 cwd，右侧只在 plan 模式显示提示。
  return (
    <Box justifyContent="space-between" width="100%">
      <Text>
        <Text color={tuiColors.textStrong}>{modelLabel || "mock"}</Text>
        <Text color={tuiColors.textDim}> · </Text>
        <Text color={tuiColors.textDim}>{cwd}</Text>
      </Text>
      {mode === "plan" ? (
        <Text color={tuiColors.warning}>Plan mode (shift+tab to cycle)</Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
