import type { EnvironmentId } from "@t3tools/contracts";
import type { WorkItem } from "@t3tools/shared/one-chat";

import { LargeDialog } from "./large-dialog";
import { type WorkLookup, WorkList } from "./work-row";

/** "Open large": the same work list in a dialog that can go full screen. */
export function WorkModal({
  open,
  onOpenChange,
  title,
  items,
  environmentId,
  lookup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: ReadonlyArray<WorkItem>;
  environmentId: EnvironmentId | null;
  lookup: WorkLookup;
}) {
  return (
    <LargeDialog open={open} onOpenChange={onOpenChange} title={title} name="work">
      <WorkList
        items={items}
        environmentId={environmentId}
        lookup={lookup}
        onReveal={() => onOpenChange(false)}
      />
    </LargeDialog>
  );
}
