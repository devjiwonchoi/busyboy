import type { ScopedThreadRef } from "@t3tools/contracts";
import { LayoutGridIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";

/** Open once per entry; phones keep the conversation visible until requested. */
export function useOpenDirectorWorkspaceOnEntry(
  threadRef: ScopedThreadRef | null,
  isDirector: boolean,
) {
  const mobile = useMediaQuery("max-sm");
  const enteredFor = useRef<string | null>(null);
  const key =
    threadRef === null || !isDirector ? null : `${threadRef.environmentId}:${threadRef.threadId}`;
  useEffect(() => {
    if (enteredFor.current === key) {
      return;
    }
    enteredFor.current = key;
    if (threadRef !== null && key !== null && !mobile) {
      useRightPanelStore.getState().open(threadRef, "director-workspace");
    }
  }, [key, mobile, threadRef]);
}

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
