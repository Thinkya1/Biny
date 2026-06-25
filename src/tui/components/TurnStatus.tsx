/**
 * 当前轮次状态组件。
 *
 * Agent 正在工作时显示 `working`，发生错误时显示 error，完成后显示上一轮耗时。
 * idle 状态不渲染任何内容，避免终端底部长期占位。
 */
import React from "react";
import { Box, Text } from "ink";
import type { RuntimeStatus } from "../../runtime/events.js";
import { tuiColors } from "../theme/index.js";

export interface TurnStatusProps {
  status: RuntimeStatus;
  turnStartedAt?: number;
  lastWorkedMs?: number;
}

export function TurnStatus({ status, turnStartedAt, lastWorkedMs }: TurnStatusProps): React.ReactElement | null {
  // idle 状态不显示分隔条，避免界面底部长期占一行。
  const label = statusLabel(status, turnStartedAt, lastWorkedMs);
  if (!label) return null;

  return (
    <Box marginTop={1} marginBottom={1}>
      <Text color={tuiColors.border}>─ </Text>
      <Text color={statusColor(status, turnStartedAt)}>{label}</Text>
      <Text color={tuiColors.border}> ─────────────────────────────────────────────────────────────</Text>
    </Box>
  );
}

function statusLabel(status: RuntimeStatus, turnStartedAt?: number, lastWorkedMs?: number): string | undefined {
  // 运行中统一显示 working；完成后才显示本轮耗时。
  if (turnStartedAt !== undefined && status !== "idle" && status !== "completed" && status !== "error") return "working";
  if (status === "completed" && lastWorkedMs !== undefined) return `worked for ${formatDuration(lastWorkedMs)}`;
  if (status === "error") return "error";
  return undefined;
}

function statusColor(status: RuntimeStatus, turnStartedAt?: number): string {
  // 只有运行中和错误需要醒目颜色，完成状态用灰色降低干扰。
  if (turnStartedAt !== undefined && status !== "idle" && status !== "completed" && status !== "error") return tuiColors.primary;
  if (status === "error") return tuiColors.error;
  return tuiColors.textDim;
}

function formatDuration(ms: number): string {
  // 小于一分钟按秒显示，长任务按分秒显示，保持状态栏短小。
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${String(minutes)}m ${String(rest)}s`;
}
