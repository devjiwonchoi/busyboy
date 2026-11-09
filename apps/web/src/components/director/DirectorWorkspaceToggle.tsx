import type { ScopedThreadRef } from "@t3tools/contracts";
import { LayoutGridIcon } from "lucide-react";

import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";

export function DirectorWorkspaceToggle(props: { threadRef: ScopedThreadRef }) {
  const showing = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, props.threadRef) === "director-workspace",
  );
  if (showing) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label="전체 프로젝트"
      onClick={() => useRightPanelStore.getState().open(props.threadRef, "director-workspace")}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground text-xs hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <LayoutGridIcon aria-hidden className="size-3.5" />
      전체 프로젝트
    </button>
  );
}
