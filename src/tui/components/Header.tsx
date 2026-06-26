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
  const displayText = headerDisplayText(sessionId, viewingSessionId);
  if (!displayText) return <></>;
  return (
    <Box width="100%">
      <Text color={tuiColors.warning}>{displayText}</Text>
    </Box>
  );
}

export function headerDisplayText(sessionId: string, viewingSessionId: string | undefined): string | undefined {
  // 当前会话 id 不再常驻展示；只有查看历史 session 时保留上下文提示。
  if (!viewingSessionId || viewingSessionId === sessionId) return undefined;
  return `Viewing ${viewingSessionId}`;
}
