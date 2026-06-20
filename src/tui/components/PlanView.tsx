import React from "react";
import { Box, Text } from "ink";
import type { TuiPlan } from "../plan.js";

export interface PlanViewProps {
  plan?: TuiPlan;
}

export function PlanView({ plan }: PlanViewProps): React.ReactElement | null {
  if (!plan) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>Plan Mode</Text>
      <Text><Text bold>Goal: </Text>{plan.goal}</Text>
      <Text><Text color="yellow" bold>Files: </Text>{plan.filesToInspect.slice(0, 3).join(", ")}</Text>
      <Text><Text color="yellow" bold>Tools: </Text>{plan.possibleTools.slice(0, 3).join(", ")}</Text>
      <Text color="yellow" bold>Steps</Text>
      {plan.steps.slice(0, 3).map((step, index) => (
        <Text key={`step-${String(index)}`}>  {String(index + 1)}. {step}</Text>
      ))}
      <Text><Text color="yellow" bold>Risks: </Text>{plan.risks.slice(0, 2).join(" ")}</Text>
    </Box>
  );
}
