"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

type PanelState = {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
};

const PanelStateContext = createContext<PanelState | null>(null);

export type SelectedTask = { id: string; project: string; title: string };

type TaskSelection = {
  selectedTask: SelectedTask | null;
  toggleTask: (task: SelectedTask) => void;
};

const TaskSelectionContext = createContext<TaskSelection | null>(null);

export function ShellStateProvider({ children }: { children: React.ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const togglePanel = useCallback(() => setPanelOpen((open) => !open), []);
  const panel = useMemo(() => ({ panelOpen, setPanelOpen, togglePanel }), [panelOpen, togglePanel]);
  const [selectedTask, setSelectedTask] = useState<SelectedTask | null>(null);
  const toggleTask = useCallback(
    (task: SelectedTask) => setSelectedTask((selected) => (selected?.id === task.id ? null : task)),
    [],
  );
  const selection = useMemo(() => ({ selectedTask, toggleTask }), [selectedTask, toggleTask]);
  return (
    <PanelStateContext value={panel}>
      <TaskSelectionContext value={selection}>{children}</TaskSelectionContext>
    </PanelStateContext>
  );
}

export function useShellState() {
  const panel = useContext(PanelStateContext);
  if (!panel) throw new Error("useShellState must be used inside ShellStateProvider.");
  return panel;
}

export function useTaskSelection() {
  const selection = useContext(TaskSelectionContext);
  if (!selection) throw new Error("useTaskSelection must be used inside ShellStateProvider.");
  return selection;
}
