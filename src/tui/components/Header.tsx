/**
 * TUI 顶部标题组件。
 *
 * 标题栏展示当前 session id；当用户正在查看历史 session 时，也会提示正在 viewing 的目标。
 * 它只负责轻量状态展示，不参与 session 切换。
 */
import React from "react";
import { Box, Text } from "ink";
import { tuiColors } from "../theme/index.js";

export interface HeaderProps {
  sessionId: string;
  viewingSessionId?: string;
}

export function Header({ sessionId, viewingSessionId }: HeaderProps): React.ReactElement {
  // viewingSessionId 不同于当前 recorder 时，说明用户正在查看历史 session。
  const viewing = viewingSessionId && viewingSessionId !== sessionId ? `Viewing: ${viewingSessionId}` : undefined;
  return (
    <Box width="100%" marginBottom={1}>
      <Text>
        <Text bold>Biny</Text>
        <Text color={tuiColors.textDim}>  </Text>
        <Text color={tuiColors.textDim}>{sessionId || "(starting)"}</Text>
        {viewing ? <Text color={tuiColors.warning}>  {viewing}</Text> : null}
      </Text>
    </Box>
  );
}
