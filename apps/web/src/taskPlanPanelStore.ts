import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const TASK_PLAN_PANEL_MIN_WIDTH = 260;
export const TASK_PLAN_PANEL_MAX_WIDTH = 640;
export const TASK_PLAN_PANEL_DEFAULT_WIDTH = 360;

export function clampTaskPlanPanelWidth(width: number): number {
  return Math.round(
    Math.min(TASK_PLAN_PANEL_MAX_WIDTH, Math.max(TASK_PLAN_PANEL_MIN_WIDTH, width)),
  );
}

type TaskPlanPanelState = {
  /** Desktop: whether the plan panel shows beside a task lead's chat. Remembered. */
  open: boolean;
  /** Desktop panel width in pixels. Remembered. */
  width: number;
  /** Phones: whether the plan sheet is open. Not remembered. */
  mobileOpen: boolean;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setMobileOpen: (open: boolean) => void;
};

/** The plan panel shown to the left of a task lead's chat. */
export const useTaskPlanPanelStore = create<TaskPlanPanelState>()(
  persist(
    (set) => ({
      open: true,
      width: TASK_PLAN_PANEL_DEFAULT_WIDTH,
      mobileOpen: false,
      setOpen: (open) => set({ open }),
      setWidth: (width) => set({ width: clampTaskPlanPanelWidth(width) }),
      setMobileOpen: (mobileOpen) => set({ mobileOpen }),
    }),
    {
      name: "busyboy:task-plan-panel:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ open: state.open, width: state.width }),
    },
  ),
);
