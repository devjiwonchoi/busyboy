import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

/**
 * The threads a task lead started, and the ones they started, and so on;
 * archived and deleted ones left out.
 */
export function taskChildren(
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  leadThreadId: ThreadId,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const byParent = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  for (const shell of shells) {
    const parent = shell.launchedByThreadId;
    if (parent === undefined || parent === null) continue;
    byParent.set(parent, [...(byParent.get(parent) ?? []), shell]);
  }
  const children: OrchestrationV2ThreadShell[] = [];
  const seen = new Set<ThreadId>([leadThreadId]);
  const queue = [leadThreadId];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      if (child.archivedAt === null && child.deletedAt === null) children.push(child);
    }
  }
  return children;
}

/**
 * A task lead's children that are still working: a run in progress or a
 * question waiting. A task is not moved between the Mac and the cloud while
 * any of these share its lead's checkout.
 */
export function liveTaskChildren(
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  leadThreadId: ThreadId,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  return taskChildren(shells, leadThreadId).filter(
    (child) => child.activeRunId !== null || child.pendingRuntimeRequest !== null,
  );
}
