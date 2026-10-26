import * as Effect from "effect/Effect";

import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerUseAppStateToolkit, ComputerUseStandardToolkit } from "./tools.ts";

// Computer use acts for the calling thread: its project's setting decides
// whether it is on, and later its approvals belong to that thread.
const callerThread = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Computer use");
  return thread.threadId;
});

export const layerStandard = McpToolAccess.toLayer(ComputerUseStandardToolkit, {
  computer_list_apps: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ComputerUseService.ComputerUseService;
      return yield* service.listApps({
        threadId: yield* callerThread,
        includeNotRunning: input.includeNotRunning === true,
      });
    }),
  ),
});

export const layerAppState = McpToolAccess.toLayer(ComputerUseAppStateToolkit, {
  computer_get_app_state: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ComputerUseService.ComputerUseService;
      return yield* service.getAppState({ ...input, threadId: yield* callerThread });
    }),
  ),
});
