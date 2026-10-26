import {
  ComputerUseAppState,
  OrchestratorMcpFailure,
  ComputerUseError,
  ComputerUseGetAppStateInput,
  ComputerUseListAppsInput,
  ComputerUseListAppsResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// A caller outside any thread gets OrchestratorMcpFailure before the tool runs.
const failure = Schema.Union([ComputerUseError, OrchestratorMcpFailure]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ComputerUseService.ComputerUseService,
];

const ComputerUseListAppsTool = Tool.make("computer_list_apps", {
  description:
    "List the apps on the user's Mac with their names and bundle IDs, for computer use. Only call it when you cannot tell which app the task means; computer_get_app_state accepts an app's name directly. Computer use is for app UI that has no API, CLI, or more specific tool.",
  parameters: ComputerUseListAppsInput,
  success: ComputerUseListAppsResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List apps")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerUseGetAppStateTool = Tool.make("computer_get_app_state", {
  description:
    "Read a window of a running app on the user's Mac: its accessibility tree as text, and a screenshot when asked. The app stays where it is; Busyboy does not bring it to the front. Prefer the tree, and add includeScreenshot only when the tree does not show enough, since apps expose accessibility unevenly. To check what an action changed, pass the previous snapshotId as `since` to get only the differences. The first time a turn uses an app, the user is asked to allow it and the call waits for the answer; if they decline, do not retry that app in the same turn. Some apps, such as terminals and password managers, are never available to computer use.",
  parameters: ComputerUseGetAppStateInput,
  success: ComputerUseAppState,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Read app state")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerUseStandardToolkit = Toolkit.make(ComputerUseListAppsTool);

// Registered by hand so its screenshot reaches the model as image content.
export const ComputerUseAppStateToolkit = Toolkit.make(ComputerUseGetAppStateTool);
