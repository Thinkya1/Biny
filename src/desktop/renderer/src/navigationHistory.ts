export interface DesktopNavigationTarget {
  projectId: string;
  sessionId?: string;
}

export interface DesktopNavigationState {
  entries: DesktopNavigationTarget[];
  index: number;
}

export function createNavigationState(): DesktopNavigationState {
  return { entries: [], index: -1 };
}

export function pushNavigation(state: DesktopNavigationState, target: DesktopNavigationTarget): DesktopNavigationState {
  if (sameTarget(state.entries[state.index], target)) return state;
  const entries = state.entries.slice(0, state.index + 1);
  entries.push({ projectId: target.projectId, sessionId: target.sessionId });
  return { entries, index: entries.length - 1 };
}

export function replaceNavigation(state: DesktopNavigationState, target: DesktopNavigationTarget): DesktopNavigationState {
  if (state.index < 0) return pushNavigation(state, target);
  const entries = [...state.entries];
  entries[state.index] = { projectId: target.projectId, sessionId: target.sessionId };
  return { entries, index: state.index };
}

export function moveNavigation(state: DesktopNavigationState, direction: -1 | 1): { state: DesktopNavigationState; target?: DesktopNavigationTarget } {
  const nextIndex = state.index + direction;
  if (nextIndex < 0 || nextIndex >= state.entries.length) return { state, target: undefined };
  return {
    state: { ...state, index: nextIndex },
    target: state.entries[nextIndex]
  };
}

export function canNavigateBack(state: DesktopNavigationState): boolean {
  return state.index > 0;
}

export function canNavigateForward(state: DesktopNavigationState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

function sameTarget(left: DesktopNavigationTarget | undefined, right: DesktopNavigationTarget): boolean {
  return left?.projectId === right.projectId && left?.sessionId === right.sessionId;
}
