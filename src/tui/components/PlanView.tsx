/**
 * 结构化计划预览组件。
 *
 * 这个组件把 `TuiPlan` 的目标、候选文件、工具、步骤和风险压缩成一个小面板。当前主界面主要使用
 * 文本 plan 输出，保留组件是为了后续恢复更丰富的计划视图。
 */
import React from "react";
import { Box, Text } from "ink";
import type { TuiPlan } from "../plan.js";
import { tuiColors } from "../theme/index.js";

export interface PlanViewProps {
  plan?: TuiPlan;
}

export function PlanView({ plan }: PlanViewProps): React.ReactElement | null {
  // 没有计划时不占用布局空间。
  if (!plan) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tuiColors.warning} paddingX={1}>
      <Text color={tuiColors.warning} bold>Plan Mode</Text>
      <Text><Text bold>Goal: </Text>{plan.goal}</Text>
      <Text><Text color={tuiColors.warning} bold>Files: </Text>{plan.filesToInspect.slice(0, 3).join(", ")}</Text>
      <Text><Text color={tuiColors.warning} bold>Tools: </Text>{plan.possibleTools.slice(0, 3).join(", ")}</Text>
      <Text color={tuiColors.warning} bold>Steps</Text>
      {plan.steps.slice(0, 3).map((step, index) => (
        <Text key={`step-${String(index)}`}>  {String(index + 1)}. {step}</Text>
      ))}
      <Text><Text color={tuiColors.warning} bold>Risks: </Text>{plan.risks.slice(0, 2).join(" ")}</Text>
    </Box>
  );
}
