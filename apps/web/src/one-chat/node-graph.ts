import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type NodeGraph, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";

const NODE_GRAPH_REFRESH_MS = 30_000;

const nodeGraphQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "one-chat:node-graph",
  tag: WS_METHODS.nodeGraphGet,
  staleTimeMs: NODE_GRAPH_REFRESH_MS,
  idleTtlMs: 60_000,
  refreshIntervalMs: NODE_GRAPH_REFRESH_MS,
});

/**
 * Skill-based work from the node graph adapter, refreshed every 30 seconds while mounted.
 * Null until it loads or when the call fails; the screen then shows task-based work only.
 */
export function useNodeGraph(environmentId: EnvironmentId | null): NodeGraph | null {
  return useEnvironmentQuery(
    environmentId === null ? null : nodeGraphQuery({ environmentId, input: {} }),
  ).data;
}
