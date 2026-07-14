import React from "react";
import { Box, Text } from "ink";
import { tuiColors } from "../theme/index.js";

export interface DialogFrameProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  hint?: string;
  footer?: React.ReactNode;
  width?: number | string;
  height?: number;
  children: React.ReactNode;
}

/** Shared Codex-style shell for every TUI command dialog. */
export function DialogFrame({ title, subtitle, hint, footer, width = "100%", height, children }: DialogFrameProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      overflow="hidden"
      borderStyle="single"
      borderColor={tuiColors.primary}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      <Text color={tuiColors.primary} bold wrap="truncate-end">{title}</Text>
      {subtitle ? <Text color={tuiColors.textMuted} wrap="truncate-end">{subtitle}</Text> : null}
      {hint ? <Text color={tuiColors.textMuted} wrap="truncate-end">{hint}</Text> : null}
      {children}
      {footer !== undefined ? (
        <>
          <Text> </Text>
          <Text color={tuiColors.textMuted} wrap="truncate-end">{footer}</Text>
        </>
      ) : null}
    </Box>
  );
}

export function dialogBodyRows(height: number, options: { subtitle?: boolean; hint?: boolean; footer?: boolean; blankBeforeBody?: boolean } = {}): number {
  const overhead = 2
    + 1
    + Number(options.subtitle ?? false)
    + Number(options.hint ?? false)
    + Number(options.footer ?? false) * 2
    + Number(options.blankBeforeBody ?? false);
  return Math.max(1, Math.floor(height) - overhead);
}
