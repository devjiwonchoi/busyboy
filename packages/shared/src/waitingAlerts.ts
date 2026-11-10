import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";

/** Stable identities keep count changes and attention alerts on the same source. */
export function waitingItemKeys(
  entries: readonly { environmentId: string; summary: ProjectTeamAttentionSummary }[],
) {
  const keys = new Set<string>();
  const byEnvironment = new Map<string, Set<string>>();
  for (const { environmentId, summary } of entries) {
    const environmentKeys = byEnvironment.get(environmentId) ?? new Set<string>();
    byEnvironment.set(environmentId, environmentKeys);
    for (const { item } of summary.decisionCards) {
      if (item.answeredAt === null && item.supersededAt === null) {
        keys.add(`card:${environmentId}:${item.id}`);
        environmentKeys.add(`card:${environmentId}:${item.id}`);
      }
    }
    for (const thread of summary.waitingThreads) {
      keys.add(`thread:${environmentId}:${thread.threadId}`);
      environmentKeys.add(`thread:${environmentId}:${thread.threadId}`);
    }
  }
  return { keys, byEnvironment, total: keys.size };
}

/** Call update on snapshots, then flush at the returned deadline. No timers owned here. */
export function createWaitingAlertGate(options: {
  coalesceMs: number;
  cooldownMs: number;
  now: () => number;
}) {
  const seen = new Map<string, Set<string>>();
  let deadline: number | null = null;
  let lastAlert = -Infinity;
  const pending = new Set<string>();
  return {
    update(snapshot: ReadonlyMap<string, ReadonlySet<string>>) {
      const current = new Set<string>();
      for (const [environmentId, keys] of snapshot) {
        const previous = seen.get(environmentId);
        for (const key of keys) {
          current.add(key);
          if (previous !== undefined && !previous.has(key)) {
            pending.add(key);
            deadline = Math.max(options.now() + options.coalesceMs, lastAlert + options.cooldownMs);
          }
        }
        seen.set(environmentId, new Set(keys));
      }
      for (const key of pending) {
        if (!current.has(key)) {
          pending.delete(key);
        }
      }
      if (pending.size === 0) {
        deadline = null;
      }
      return deadline;
    },
    flush() {
      if (deadline === null || options.now() < deadline) {
        return false;
      }
      deadline = null;
      const alert = pending.size > 0;
      pending.clear();
      if (alert) {
        lastAlert = options.now();
      }
      return alert;
    },
  };
}
