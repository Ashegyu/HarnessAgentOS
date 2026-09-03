export const WORKBENCH_LAYOUT_LIMITS = {
  railWidth: 60,
  statusBarHeight: 32,
  mainWorkspaceMin: 400,
  thread: {
    min: 180,
    max: 400,
    default: 272,
  },
  context: {
    min: 280,
    max: 600,
    default: 380,
  },
} as const;

type PanelKind = "thread" | "context";

export const clampPanelWidth = (value: number, panel: PanelKind): number => {
  const limits = WORKBENCH_LAYOUT_LIMITS[panel];
  return Math.max(limits.min, Math.min(limits.max, value));
};

export const readStoredPanelWidth = (
  storedValue: string | null,
  panel: PanelKind,
): number => {
  const limits = WORKBENCH_LAYOUT_LIMITS[panel];
  if (storedValue === null) return limits.default;

  const parsed = Number(storedValue);
  if (!Number.isFinite(parsed)) return limits.default;
  return clampPanelWidth(parsed, panel);
};

export const resizePanelWidth = (
  currentWidth: number,
  panel: PanelKind,
  direction: -1 | 1,
): number => clampPanelWidth(currentWidth + direction * 16, panel);

export type WorkbenchLayoutStyle = Readonly<{
  "--rail-width": string;
  "--status-bar-height": string;
  "--thread-drawer-width": string;
  "--context-drawer-width": string;
  "--main-workspace-min": string;
}>;

export const createWorkbenchLayoutStyle = (
  threadDrawerWidth: number,
  contextDrawerWidth: number,
): WorkbenchLayoutStyle => ({
  "--rail-width": `${WORKBENCH_LAYOUT_LIMITS.railWidth}px`,
  "--status-bar-height": `${WORKBENCH_LAYOUT_LIMITS.statusBarHeight}px`,
  "--thread-drawer-width": `${threadDrawerWidth}px`,
  "--context-drawer-width": `${contextDrawerWidth}px`,
  "--main-workspace-min": `${WORKBENCH_LAYOUT_LIMITS.mainWorkspaceMin}px`,
});
