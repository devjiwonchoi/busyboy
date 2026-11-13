import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type NodeGraph } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

const NODE_GRAPH_REFRESH_MS = 30_000;

/** The node graph adapter's view of skill-based work; refetched while something reads it. */
const nodeGraphAtom = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile-one-chat:node-graph",
  tag: WS_METHODS.nodeGraphGet,
  refreshIntervalMs: NODE_GRAPH_REFRESH_MS,
});

/** The node graph, or null while it loads or when the call fails; it never blocks the screen. */
export function useNodeGraph(environmentId: EnvironmentId | null): NodeGraph | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : nodeGraphAtom({ environmentId, input: {} }),
  );
  return query.error === null ? query.data : null;
}
