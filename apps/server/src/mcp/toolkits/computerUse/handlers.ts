import * as Effect from "effect/Effect";

import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerUseAppStateToolkit, ComputerUseStandardToolkit } from "./tools.ts";

// Computer use acts for the calling thread: its project's setting decides
// whether it is on, and its approvals belong to that thread's run.
const caller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Computer use");
  return { threadId: thread.threadId, providerInstanceId: thread.providerInstanceId };
});

/** Actions change the app, so read-only clients are refused before they run. */
const act = <P, A, E>(
  run: (
    service: ComputerUseService.ComputerUseService["Service"],
    input: P & { readonly caller: ComputerUseService.ComputerUseCaller },
  ) => Effect.Effect<A, E>,
) =>
  McpToolAccess.actsAsCaller((input: P) =>
    Effect.gen(function* () {
      const service = yield* ComputerUseService.ComputerUseService;
      return yield* run(service, { ...input, caller: yield* caller });
    }),
  );

export const layerStandard = McpToolAccess.toLayer(ComputerUseStandardToolkit, {
  computer_list_apps: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ComputerUseService.ComputerUseService;
      return yield* service.listApps({
        caller: yield* caller,
        includeNotRunning: input.includeNotRunning === true,
      });
    }),
  ),
  computer_click: act((service, input) => service.click(input)),
  computer_type_text: act((service, input) => service.typeText(input)),
  computer_press_key: act((service, input) => service.pressKey(input)),
  computer_scroll: act((service, input) => service.scroll(input)),
  computer_drag: act((service, input) => service.drag(input)),
  computer_set_value: act((service, input) => service.setValue(input)),
  computer_invoke_menu: act((service, input) => service.invokeMenu(input)),
});

export const layerAppState = McpToolAccess.toLayer(ComputerUseAppStateToolkit, {
  computer_get_app_state: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ComputerUseService.ComputerUseService;
      return yield* service.getAppState({ ...input, caller: yield* caller });
    }),
  ),
});
